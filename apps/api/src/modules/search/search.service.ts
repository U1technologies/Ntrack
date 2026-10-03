import { z } from 'zod';
import { Prisma } from '@ntrack/db';
import { generatePublicId, parseCsv, parseReportDate, parseReportNumber, CURRENCIES } from '@ntrack/shared';
import { resolveDateRange, DateRangeQuery } from '../../lib/date-range';
import { AppError } from '../../lib/errors';
import { serialize } from '../../lib/serialize';
import { amount } from '../campaigns/campaigns.schemas';
import { writeAudit } from '../../services/audit';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';

export const PartnerBody = z.object({
  name: z.string().trim().min(2).max(120),
  adapter: z.enum(['csv', 'manual']).default('csv'),
  revenueSharePercent: z.coerce.number().min(0).max(100).default(100),
  currency: z.enum(CURRENCIES).default('USD'),
  active: z.boolean().default(true),
  contactEmail: z.union([z.literal(''), z.string().email()]).default(''),
  notes: z.string().trim().max(2000).default(''),
});

export const FeedBody = z.object({
  name: z.string().trim().min(1).max(120),
  externalCode: z.string().trim().min(1).max(120),
  campaignId: z.string().uuid().nullish(),
  active: z.boolean().default(true),
});

/** Which CSV header holds each field. Only date, feed and gross revenue are required. */
export const ImportBody = z.object({
  csv: z.string().min(1).max(1_000_000),
  dateFormat: z.enum(['ymd', 'mdy', 'dmy']).default('ymd'),
  mapping: z.object({
    date: z.string().trim().toLowerCase().min(1),
    feed: z.string().trim().toLowerCase().min(1),
    grossRevenue: z.string().trim().toLowerCase().min(1),
    netRevenue: z.string().trim().toLowerCase().optional(),
    searches: z.string().trim().toLowerCase().optional(),
    paidClicks: z.string().trim().toLowerCase().optional(),
    country: z.string().trim().toLowerCase().optional(),
  }),
});

export const ManualRecordBody = z.object({
  feedId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  country: z.string().trim().toUpperCase().max(2).default(''),
  searches: z.coerce.number().int().min(0).default(0),
  paidClicks: z.coerce.number().int().min(0).default(0),
  // Decimal strings end to end, so manual entries are as exact as imports.
  grossRevenue: amount,
  netRevenue: amount.optional(),
});

export const CostBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  feedId: z.string().uuid().nullish(),
  campaignId: z.string().uuid().nullish(),
  source: z.string().trim().min(1).max(80),
  cost: amount,
  currency: z.enum(CURRENCIES).default('USD'),
  clicksPurchased: z.coerce.number().int().min(0).nullish(),
  notes: z.string().trim().max(500).default(''),
});

export const SearchReportQuery = DateRangeQuery.extend({ groupBy: z.enum(['date', 'feed', 'partner']).default('date'), partnerId: z.string().uuid().optional() });

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/**
 * Search monetization: partners and feeds, partner-reported revenue (imported as reported, never
 * estimated), acquired traffic cost, and reconciliation against clicks NTrack measured itself.
 */
export class SearchService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma() {
    return this.deps.prisma;
  }

  listPartners(auth: OrgAuthContext) {
    return this.prisma.searchPartner
      .findMany({ where: { organizationId: auth.organizationId }, include: { feeds: { orderBy: { name: 'asc' } }, _count: { select: { records: true } } }, orderBy: { name: 'asc' } })
      .then(serialize);
  }

  private async partner(auth: OrgAuthContext, id: string) {
    const partner = await this.prisma.searchPartner.findFirst({ where: { id, organizationId: auth.organizationId } });
    if (!partner) throw AppError.notFound('Search partner');
    return partner;
  }

  async createPartner(auth: OrgAuthContext, input: z.infer<typeof PartnerBody>, meta: RequestMeta) {
    const partner = await this.prisma.searchPartner.create({ data: { ...input, publicId: generatePublicId('sp'), organizationId: auth.organizationId } });
    await writeAudit(this.prisma, auth, meta, { action: 'search_partner.created', entityType: 'search_partner', entityId: partner.id, summary: partner.name });
    return serialize(partner);
  }

  async updatePartner(auth: OrgAuthContext, id: string, input: Partial<z.infer<typeof PartnerBody>>, meta: RequestMeta) {
    const before = await this.partner(auth, id);
    const after = await this.prisma.searchPartner.update({ where: { id }, data: input });
    await writeAudit(this.prisma, auth, meta, { action: 'search_partner.updated', entityType: 'search_partner', entityId: id, before, after });
    return serialize(after);
  }

  async addFeed(auth: OrgAuthContext, partnerId: string, input: z.infer<typeof FeedBody>, meta: RequestMeta) {
    await this.partner(auth, partnerId);
    if (input.campaignId && !(await this.prisma.campaign.findFirst({ where: { id: input.campaignId, organizationId: auth.organizationId } }))) throw AppError.badRequest('Unknown campaign');
    const feed = await this.prisma.searchFeed.create({ data: { ...input, campaignId: input.campaignId ?? null, partnerId, organizationId: auth.organizationId } });
    await writeAudit(this.prisma, auth, meta, { action: 'search_feed.created', entityType: 'search_partner', entityId: partnerId, summary: feed.externalCode });
    return feed;
  }

  async updateFeed(auth: OrgAuthContext, feedId: string, input: Partial<z.infer<typeof FeedBody>>, meta: RequestMeta) {
    const feed = await this.prisma.searchFeed.findFirst({ where: { id: feedId, organizationId: auth.organizationId } });
    if (!feed) throw AppError.notFound('Feed');
    // Same tenant check as addFeed: a feed may only point at this organization's campaigns.
    if (input.campaignId && !(await this.prisma.campaign.findFirst({ where: { id: input.campaignId, organizationId: auth.organizationId } }))) throw AppError.badRequest('Unknown campaign');
    const after = await this.prisma.searchFeed.update({ where: { id: feedId }, data: input });
    await writeAudit(this.prisma, auth, meta, { action: 'search_feed.updated', entityType: 'search_partner', entityId: feed.partnerId, before: feed, after });
    return after;
  }

  /** Imports a partner report. Rows are upserted by feed + date + country, so re-importing a corrected report replaces the figures. */
  async importReport(auth: OrgAuthContext, partnerId: string, input: z.infer<typeof ImportBody>, meta: RequestMeta) {
    const partner = await this.partner(auth, partnerId);
    let parsed;
    try {
      parsed = parseCsv(input.csv);
    } catch (error) {
      throw AppError.badRequest((error as Error).message);
    }
    const missing = Object.values(input.mapping).filter((h): h is string => Boolean(h) && !parsed.headers.includes(h!));
    if (missing.length) throw AppError.badRequest(`Columns not found in the file: ${missing.join(', ')}`, { headers: parsed.headers });

    const feeds = await this.prisma.searchFeed.findMany({ where: { partnerId } });
    const feedByCode = new Map(feeds.map((f) => [f.externalCode.toLowerCase(), f]));
    const batch = `imp_${Date.now()}`;
    const skipped: Array<{ line: number; reason: string }> = [];
    const share = D(partner.revenueSharePercent).dividedBy(100);
    // Rows for the same feed, date and country in one file are summed (e.g. a report split by
    // sub-channel), then written once; re-importing a corrected file still replaces the figures.
    const merged = new Map<string, { feedId: string; date: string; country: string; searches: number; paidClicks: number; gross: Prisma.Decimal; net: Prisma.Decimal; rows: number }>();

    for (const { line, values } of parsed.records) {
      const m = input.mapping;
      const date = parseReportDate(values[m.date], input.dateFormat);
      const feed = feedByCode.get((values[m.feed] ?? '').toLowerCase());
      const gross = parseReportNumber(values[m.grossRevenue]);
      if (!date) skipped.push({ line, reason: `Unreadable date "${values[m.date]}"` });
      else if (!feed) skipped.push({ line, reason: `Unknown feed code "${values[m.feed]}". Add it to the partner's feeds first.` });
      else if (gross === null) skipped.push({ line, reason: `Unreadable revenue "${values[m.grossRevenue]}"` });
      else {
        const net = m.netRevenue ? parseReportNumber(values[m.netRevenue]) : null;
        const country = m.country ? (values[m.country] ?? '').toUpperCase().slice(0, 2) : '';
        const key = `${feed.id}|${date}|${country}`;
        const entry = merged.get(key) ?? { feedId: feed.id, date, country, searches: 0, paidClicks: 0, gross: D(0), net: D(0), rows: 0 };
        entry.searches += m.searches ? Math.round(Number(parseReportNumber(values[m.searches]) ?? 0)) : 0;
        entry.paidClicks += m.paidClicks ? Math.round(Number(parseReportNumber(values[m.paidClicks]) ?? 0)) : 0;
        entry.gross = entry.gross.plus(gross);
        entry.net = entry.net.plus(net ?? D(gross).times(share));
        entry.rows += 1;
        merged.set(key, entry);
      }
    }
    let imported = 0;
    for (const entry of merged.values()) {
      const data = {
        searches: entry.searches,
        paidClicks: entry.paidClicks,
        grossRevenue: entry.gross.toFixed(6),
        netRevenue: entry.net.toFixed(6),
        currency: partner.currency,
        source: 'csv',
        importBatch: batch,
      };
      await this.prisma.searchRevenueRecord.upsert({
        where: { feedId_date_country: { feedId: entry.feedId, date: day(entry.date), country: entry.country } },
        create: { ...data, organizationId: auth.organizationId, partnerId, feedId: entry.feedId, date: day(entry.date), country: entry.country },
        update: data,
      });
      imported += entry.rows;
    }
    await writeAudit(this.prisma, auth, meta, { action: 'search_revenue.imported', entityType: 'search_partner', entityId: partnerId, summary: `${imported} rows imported, ${skipped.length} skipped (${batch})` });
    return { imported, records: merged.size, skipped: skipped.slice(0, 200), skippedCount: skipped.length, batch };
  }

  async addRecord(auth: OrgAuthContext, input: z.infer<typeof ManualRecordBody>, meta: RequestMeta) {
    const feed = await this.prisma.searchFeed.findFirst({ where: { id: input.feedId, organizationId: auth.organizationId }, include: { partner: true } });
    if (!feed) throw AppError.badRequest('Unknown feed');
    const net = input.netRevenue ?? D(input.grossRevenue).times(D(feed.partner.revenueSharePercent).dividedBy(100)).toFixed(6);
    const data = { searches: input.searches, paidClicks: input.paidClicks, grossRevenue: input.grossRevenue, netRevenue: net, currency: feed.partner.currency, source: 'manual' };
    const record = await this.prisma.searchRevenueRecord.upsert({
      where: { feedId_date_country: { feedId: feed.id, date: day(input.date), country: input.country } },
      create: { ...data, organizationId: auth.organizationId, partnerId: feed.partnerId, feedId: feed.id, date: day(input.date), country: input.country },
      update: data,
    });
    await writeAudit(this.prisma, auth, meta, { action: 'search_revenue.manual', entityType: 'search_partner', entityId: feed.partnerId, summary: `${feed.externalCode} ${input.date}` });
    return serialize(record);
  }

  listCosts(auth: OrgAuthContext) {
    return this.prisma.trafficCost.findMany({ where: { organizationId: auth.organizationId }, orderBy: { date: 'desc' }, take: 500 }).then(serialize);
  }

  async addCost(auth: OrgAuthContext, input: z.infer<typeof CostBody>, meta: RequestMeta) {
    if (input.feedId && !(await this.prisma.searchFeed.findFirst({ where: { id: input.feedId, organizationId: auth.organizationId } }))) throw AppError.badRequest('Unknown feed');
    if (input.campaignId && !(await this.prisma.campaign.findFirst({ where: { id: input.campaignId, organizationId: auth.organizationId } }))) throw AppError.badRequest('Unknown campaign');
    const cost = await this.prisma.trafficCost.create({ data: { ...input, feedId: input.feedId ?? null, campaignId: input.campaignId ?? null, date: day(input.date), organizationId: auth.organizationId } });
    await writeAudit(this.prisma, auth, meta, { action: 'traffic_cost.created', entityType: 'traffic_cost', entityId: cost.id, summary: `${input.source} ${input.cost} ${input.currency} on ${input.date}` });
    return serialize(cost);
  }

  async removeCost(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    const cost = await this.prisma.trafficCost.findFirst({ where: { id, organizationId: auth.organizationId } });
    if (!cost) throw AppError.notFound('Cost entry');
    await this.prisma.trafficCost.delete({ where: { id } });
    await writeAudit(this.prisma, auth, meta, { action: 'traffic_cost.deleted', entityType: 'traffic_cost', entityId: id, before: cost });
  }

  /**
   * Reconciliation and profitability: partner-reported searches, paid clicks and revenue next to
   * valid clicks NTrack recorded on each feed's linked campaign, plus traffic cost.
   */
  async report(auth: OrgAuthContext, query: z.infer<typeof SearchReportQuery>) {
    const range = resolveDateRange(query, auth.organizationTimezone);
    const fromDay = day(range.fromDay);
    const toDay = day(range.toDay);
    const feeds = await this.prisma.searchFeed.findMany({
      where: { organizationId: auth.organizationId, ...(query.partnerId ? { partnerId: query.partnerId } : {}) },
      include: { partner: { select: { id: true, name: true, currency: true } } },
    });
    const [records, costs] = await Promise.all([
      this.prisma.searchRevenueRecord.findMany({ where: { organizationId: auth.organizationId, feedId: { in: feeds.map((f) => f.id) }, date: { gte: fromDay, lte: toDay } } }),
      this.prisma.trafficCost.findMany({ where: { organizationId: auth.organizationId, date: { gte: fromDay, lte: toDay } } }),
    ]);

    // NTrack-measured valid clicks per campaign and day (organization timezone).
    const campaignIds = [...new Set(feeds.flatMap((f) => (f.campaignId ? [f.campaignId] : [])))];
    const clickRows = campaignIds.length
      ? await (
          await this.deps.clickhouse.query({
            query: `SELECT toString(campaign_id) AS campaign_id, toString(toDate(ts, {tz:String})) AS day, countIf(is_valid = 1) AS clicks
                    FROM clicks WHERE organization_id = {org:UUID} AND campaign_id IN {campaigns:Array(UUID)}
                      AND ts >= {from:DateTime64(3)} AND ts < {to:DateTime64(3)} GROUP BY campaign_id, day`,
            query_params: { tz: range.timezone, org: auth.organizationId, campaigns: campaignIds, from: range.from.replace('T', ' ').replace('Z', ''), to: range.to.replace('T', ' ').replace('Z', '') },
            format: 'JSONEachRow',
          })
        ).json<{ campaign_id: string; day: string; clicks: string }>()
      : [];

    type Row = { key: string; label: string; searches: number; paidClicks: number; ntrackClicks: number; gross: Prisma.Decimal; net: Prisma.Decimal; cost: Prisma.Decimal; currency: string };
    const rows = new Map<string, Row>();
    const keyFor = (feed: (typeof feeds)[number], date: string) =>
      query.groupBy === 'date' ? { key: date, label: date } : query.groupBy === 'feed' ? { key: feed.id, label: `${feed.partner.name} / ${feed.name}` } : { key: feed.partner.id, label: feed.partner.name };
    // Rows are split by currency so amounts in different currencies are never added together.
    const row = (feed: (typeof feeds)[number], date: string, currency = feed.partner.currency) => {
      const { key: groupKey, label } = keyFor(feed, date);
      const key = `${groupKey}|${currency}`;
      if (!rows.has(key)) rows.set(key, { key, label, searches: 0, paidClicks: 0, ntrackClicks: 0, gross: D(0), net: D(0), cost: D(0), currency });
      return rows.get(key)!;
    };
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    for (const record of records) {
      const feed = feeds.find((f) => f.id === record.feedId)!;
      const r = row(feed, iso(record.date));
      r.searches += record.searches;
      r.paidClicks += record.paidClicks;
      r.gross = r.gross.plus(record.grossRevenue);
      r.net = r.net.plus(record.netRevenue);
    }
    // A campaign's clicks are counted once per output row, even when several feeds share the campaign.
    const counted = new Set<string>();
    for (const click of clickRows) {
      for (const feed of feeds.filter((f) => f.campaignId === click.campaign_id)) {
        const target = row(feed, click.day);
        const mark = `${target.key}|${click.campaign_id}|${click.day}`;
        if (counted.has(mark)) continue;
        counted.add(mark);
        target.ntrackClicks += Number(click.clicks);
      }
    }
    const unallocated = new Map<string, Prisma.Decimal>();
    for (const cost of costs) {
      // A cost tied to a campaign shared by several feeds is attributed to the first feed found.
      const feed = feeds.find((f) => f.id === cost.feedId) ?? feeds.find((f) => f.campaignId && f.campaignId === cost.campaignId);
      if (feed) {
        const target = row(feed, iso(cost.date), cost.currency);
        target.cost = target.cost.plus(cost.cost);
      } else if (!query.partnerId) {
        unallocated.set(cost.currency, (unallocated.get(cost.currency) ?? D(0)).plus(cost.cost));
      }
    }

    const output = [...rows.values()]
      .map((r) => {
        const margin = r.net.minus(r.cost);
        return {
          key: r.key,
          label: r.label,
          currency: r.currency,
          ntrackClicks: r.ntrackClicks,
          partnerSearches: r.searches,
          paidClicks: r.paidClicks,
          monetizationRate: r.searches ? r.paidClicks / r.searches : null,
          discrepancy: r.ntrackClicks ? (r.searches - r.ntrackClicks) / r.ntrackClicks : null,
          grossRevenue: r.gross.toFixed(2),
          netRevenue: r.net.toFixed(2),
          cost: r.cost.toFixed(2),
          margin: margin.toFixed(2),
          rpc: r.ntrackClicks ? r.net.dividedBy(r.ntrackClicks).toFixed(4) : null,
          epcPaid: r.paidClicks ? r.net.dividedBy(r.paidClicks).toFixed(4) : null,
          roi: r.cost.greaterThan(0) ? margin.dividedBy(r.cost).toNumber() : null,
        };
      })
      .sort((a, b) => (query.groupBy === 'date' ? a.key.localeCompare(b.key) : Number(b.netRevenue) - Number(a.netRevenue)));
    return {
      range,
      groupBy: query.groupBy,
      rows: output,
      unlinkedFeeds: feeds.filter((f) => !f.campaignId).map((f) => f.name),
      /** Costs in the period not linked to any feed (directly or via its campaign); excluded from margins. */
      unallocatedCosts: [...unallocated].map(([currency, total]) => ({ currency, cost: total.toFixed(2) })),
    };
  }
}
