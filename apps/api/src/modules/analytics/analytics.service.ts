import { z } from 'zod';
import {
  CLICK_DIMENSIONS,
  CLICK_METRICS,
  isFilterableClickDimension,
  runClickLog,
  runClickReport,
  runConversionReport,
  type ClickDimension,
  type ClickMetric,
} from '@ntrack/analytics';
import { ALL_METRIC_KEYS, CLICK_METRIC_KEYS, CONVERSION_METRIC_KEYS, DERIVED_METRIC_KEYS, allowedMetrics, computeDerived, type MetricKey } from '../../services/performance-metrics';
import { conversionWhere } from '../../services/access-scope';
import { resolveDateRange, DateRangeQuery } from '../../lib/date-range';
import { analyticsScope, campaignWhere, publisherWhere } from '../../services/access-scope';
import { resolveEntityNames, type EntityNames } from '../../services/entity-names';
import { toCsv } from '../../lib/tabular';
import type { AppDeps, OrgAuthContext } from '../../types';

type Row = Record<string, unknown>;

const NAMED_DIMENSIONS = ['campaign', 'publisher', 'advertiser', 'domain'] as const;

/** Adds `<dimension>_name` next to every UUID dimension so the console can display names. */
const attachNames = (rows: Row[], names: EntityNames) =>
  rows.map((row) => {
    const output: Row = { ...row };
    for (const dimension of NAMED_DIMENSIONS) {
      const id = row[dimension] ?? row[`${dimension}_id`];
      if (typeof id === 'string') output[`${dimension}_name`] = names[dimension].get(id) ?? 'Unknown';
    }
    return output;
  });

const collectIds = (rows: Row[]) => ({
  campaign: rows.flatMap((r) => [r.campaign, r.campaign_id]),
  publisher: rows.flatMap((r) => [r.publisher, r.publisher_id]),
  advertiser: rows.flatMap((r) => [r.advertiser, r.advertiser_id]),
  domain: rows.flatMap((r) => [r.domain, r.domain_id]),
});

const numeric = (rows: Row[]) =>
  rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, k in CLICK_METRICS && typeof v === 'string' ? Number(v) : v])));

/** Columns for an export: `<dimension>_name` next to each ID dimension, then the metrics. */
export const exportColumns = (dimensions: string[], metrics: string[]) =>
  dimensions.flatMap((d) => (['campaign', 'publisher', 'advertiser', 'domain'].includes(d) ? [`${d}_name`, d] : [d])).concat(metrics);

export const ClickReportBody = DateRangeQuery.extend({
  dimensions: z.array(z.enum(Object.keys(CLICK_DIMENSIONS) as [ClickDimension, ...ClickDimension[]])).max(4).default(['date']),
  metrics: z.array(z.enum(Object.keys(CLICK_METRICS) as [ClickMetric, ...ClickMetric[]])).max(5).default(['clicks', 'unique_clicks', 'valid_clicks', 'invalid_clicks']),
  filters: z.record(z.string(), z.array(z.string().max(255)).max(100)).default({}),
  sort: z.object({ field: z.string(), direction: z.enum(['asc', 'desc']) }).optional(),
  limit: z.number().int().min(1).max(10_000).default(500),
  offset: z.number().int().min(0).default(0),
});

export const PerformanceReportBody = DateRangeQuery.extend({
  dimensions: z.array(z.enum(['event', 'status', 'conversion_source', ...Object.keys(CLICK_DIMENSIONS)] as [string, ...string[]])).max(4).default(['date']),
  metrics: z.array(z.enum(ALL_METRIC_KEYS)).min(1).max(20).default(['clicks', 'conversions', 'revenue', 'payout', 'profit', 'cr', 'epc']),
  filters: z.record(z.string(), z.array(z.string().max(255)).max(100)).default({}),
  limit: z.number().int().min(1).max(10_000).default(1000),
});

export const ClickLogQuery = DateRangeQuery.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  campaignId: z.string().uuid().optional(),
  publisherId: z.string().uuid().optional(),
  domainId: z.string().uuid().optional(),
  clickId: z.string().trim().max(32).optional(),
  country: z.string().trim().max(2).optional(),
  onlyInvalid: z.enum(['true', 'false']).optional(),
});

export class AnalyticsService {
  constructor(private readonly deps: AppDeps) {}

  private report(auth: OrgAuthContext, range: { from: string; to: string; timezone: string }, dimensions: ClickDimension[], metrics: ClickMetric[], limit = 100) {
    return runClickReport<Row>(this.deps.clickhouse, {
      scope: analyticsScope(auth),
      from: range.from,
      to: range.to,
      timezone: range.timezone,
      dimensions,
      metrics,
      limit,
    }).then(numeric);
  }

  async dashboard(auth: OrgAuthContext, query: DateRangeQuery) {
    const range = resolveDateRange(query, auth.organizationTimezone);
    const trendDimension: ClickDimension = range.days === 1 ? 'hour' : 'date';
    const base = ['clicks', 'unique_clicks', 'valid_clicks', 'invalid_clicks'] as ClickMetric[];

    const [totals, trend, countries, devices, browsers, os, sources, campaigns, publishers, advertisers, recent] = await Promise.all([
      this.report(auth, range, [], base, 1),
      this.report(auth, range, [trendDimension], base, 1000),
      this.report(auth, range, ['country'], ['clicks'], 10),
      this.report(auth, range, ['device'], ['clicks'], 10),
      this.report(auth, range, ['browser'], ['clicks'], 10),
      this.report(auth, range, ['os'], ['clicks'], 10),
      this.report(auth, range, ['source'], ['clicks'], 10),
      this.report(auth, range, ['campaign'], base, 10),
      this.report(auth, range, ['publisher'], base, 10),
      this.report(auth, range, ['advertiser'], ['clicks', 'valid_clicks'], 10),
      runClickLog<Row>(this.deps.clickhouse, { scope: analyticsScope(auth), from: range.from, to: range.to, limit: 10, offset: 0 }),
    ]);

    const conversionScope = analyticsScope(auth);
    const [convTotals, convTrend, convByCampaign, convByPublisher, recentConversions] = await Promise.all([
      runConversionReport(this.deps.clickhouse, { scope: conversionScope, from: range.from, to: range.to, timezone: range.timezone, dimensions: [] }),
      runConversionReport(this.deps.clickhouse, { scope: conversionScope, from: range.from, to: range.to, timezone: range.timezone, dimensions: [trendDimension], limit: 1000 }),
      runConversionReport(this.deps.clickhouse, { scope: conversionScope, from: range.from, to: range.to, timezone: range.timezone, dimensions: ['campaign'], limit: 500 }),
      runConversionReport(this.deps.clickhouse, { scope: conversionScope, from: range.from, to: range.to, timezone: range.timezone, dimensions: ['publisher'], limit: 500 }),
      this.deps.prisma.conversion.findMany({
        where: { organizationId: auth.organizationId, ...conversionWhere(auth.scope) },
        orderBy: { convertedAt: 'desc' },
        take: 10,
        include: { campaign: { select: { name: true } }, publisher: { select: { companyName: true } } },
      }),
    ]);
    const mergeBy = (rows: Row[], conv: Row[] | null, key: string) =>
      rows.map((row) => {
        const match = (conv ?? []).find((c) => c[key] === row[key]);
        return { ...row, conversions: Number(match?.conversions ?? 0), revenue: match?.revenue ?? '0', payout: match?.payout ?? '0' };
      });
    const trendRows = trend.map((row) => {
      const match = (convTrend ?? []).find((c) => String(c[trendDimension]) === String(row[trendDimension]));
      return { ...row, conversions: Number(match?.conversions ?? 0) };
    });

    const names = await resolveEntityNames(this.deps.prisma, auth.organizationId, collectIds([...campaigns, ...publishers, ...advertisers, ...recent.rows]));
    const pending = await this.pendingApprovals(auth);
    const total = totals[0] ?? { clicks: 0, unique_clicks: 0, valid_clicks: 0, invalid_clicks: 0 };
    const conv = convTotals?.[0] ?? {};
    const derived = computeDerived({ ...total, ...conv });
    const visible = new Set(allowedMetrics(auth.scope, auth.permissions.has('payouts.view'), ['revenue', 'payout', 'profit', 'margin', 'epc', 'rpc', 'roi']));
    const money = (key: MetricKey, value: unknown) => (visible.has(key) ? value : null);

    return {
      range,
      kpis: {
        clicks: Number(total.clicks ?? 0),
        uniqueClicks: Number(total.unique_clicks ?? 0),
        validClicks: Number(total.valid_clicks ?? 0),
        invalidClicks: Number(total.invalid_clicks ?? 0),
        conversions: Number(conv.conversions ?? 0),
        approvedConversions: Number(conv.approved_conversions ?? 0),
        pendingConversions: Number(conv.pending_conversions ?? 0),
        rejectedConversions: Number(conv.rejected_conversions ?? 0),
        revenue: money('revenue', conv.revenue ?? '0'),
        approvedRevenue: money('revenue', conv.approved_revenue ?? '0'),
        payout: money('payout', conv.payout ?? '0'),
        profit: money('profit', derived.profit),
        margin: money('margin', derived.margin),
        epc: money('epc', derived.epc),
        conversionRate: derived.cr,
        roi: money('roi', derived.roi),
      },
      trend: { dimension: trendDimension, rows: trendRows },
      distributions: { countries, devices, browsers, os, sources },
      top: {
        campaigns: attachNames(mergeBy(campaigns, convByCampaign, 'campaign'), names),
        publishers: attachNames(mergeBy(publishers, convByPublisher, 'publisher'), names),
        advertisers: attachNames(advertisers, names),
      },
      recentClicks: attachNames(recent.rows, names),
      recentConversions: recentConversions.map((c) => ({
        id: c.id,
        publicId: c.publicId,
        convertedAt: c.convertedAt,
        status: c.status,
        event: c.event,
        campaign: c.campaign.name,
        publisher: c.publisher.companyName,
        payout: visible.has('payout') ? c.payout.toString() : null,
        revenue: visible.has('revenue') ? c.revenue.toString() : null,
        currency: c.currency,
      })),
      pending,
    };
  }

  private async pendingApprovals(auth: OrgAuthContext) {
    const { prisma } = this.deps;
    const canApprove = auth.permissions.has('campaigns.approve') || auth.permissions.has('publishers.approve');
    if (!canApprove) return null;
    const [applications, publishers, campaigns] = await Promise.all([
      prisma.campaignPublisher.count({ where: { organizationId: auth.organizationId, status: 'pending', campaign: campaignWhere(auth.scope) } }),
      auth.permissions.has('publishers.approve')
        ? prisma.publisher.count({ where: { organizationId: auth.organizationId, status: 'pending', ...publisherWhere(auth.scope) } })
        : 0,
      prisma.campaign.count({ where: { organizationId: auth.organizationId, status: 'pending', ...campaignWhere(auth.scope) } }),
    ]);
    return { applications, publishers, campaigns };
  }

  async clickReport(auth: OrgAuthContext, body: z.infer<typeof ClickReportBody>) {
    const range = resolveDateRange(body, auth.organizationTimezone);
    const filters = Object.fromEntries(Object.entries(body.filters).filter(([dimension]) => isFilterableClickDimension(dimension))) as Partial<Record<ClickDimension, string[]>>;
    const rows = numeric(
      await runClickReport<Row>(this.deps.clickhouse, {
        scope: analyticsScope(auth),
        from: range.from,
        to: range.to,
        timezone: range.timezone,
        dimensions: body.dimensions,
        metrics: body.metrics,
        filters,
        sort: body.sort as { field: ClickDimension | ClickMetric; direction: 'asc' | 'desc' } | undefined,
        limit: body.limit,
        offset: body.offset,
      })
    );
    const names = await resolveEntityNames(this.deps.prisma, auth.organizationId, collectIds(rows));
    return { range, dimensions: body.dimensions, metrics: body.metrics, rows: attachNames(rows, names) };
  }

  async clickLog(auth: OrgAuthContext, query: z.infer<typeof ClickLogQuery>) {
    const range = resolveDateRange(query, auth.organizationTimezone);
    const filters: Partial<Record<ClickDimension, string[]>> = {};
    if (query.campaignId) filters.campaign = [query.campaignId];
    if (query.publisherId) filters.publisher = [query.publisherId];
    if (query.domainId) filters.domain = [query.domainId];
    if (query.country) filters.country = [query.country.toUpperCase()];
    const { rows, total } = await runClickLog<Row>(this.deps.clickhouse, {
      scope: analyticsScope(auth),
      from: range.from,
      to: range.to,
      filters,
      clickId: query.clickId,
      onlyInvalid: query.onlyInvalid === 'true',
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    });
    const names = await resolveEntityNames(this.deps.prisma, auth.organizationId, collectIds(rows));
    return {
      range,
      items: attachNames(rows, names),
      pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) },
    };
  }

  /**
   * Click and conversion metrics side by side. Each side is aggregated by the same dimensions and
   * merged by dimension values; derived ratios are computed on the merged row. Dimensions that only
   * exist on one side (e.g. browser) return null for the other side's metrics.
   */
  async performanceReport(auth: OrgAuthContext, body: z.infer<typeof PerformanceReportBody>) {
    const range = resolveDateRange(body, auth.organizationTimezone);
    const metrics = allowedMetrics(auth.scope, auth.permissions.has('payouts.view'), body.metrics as MetricKey[]);
    const clickDims = body.dimensions.filter((d): d is ClickDimension => d in CLICK_DIMENSIONS);
    const conversionOnlyDims = body.dimensions.length !== clickDims.length;
    const needsClicks = !conversionOnlyDims && metrics.some((m) => (CLICK_METRIC_KEYS as readonly string[]).includes(m) || ['epc', 'rpc', 'cr'].includes(m));
    const needsConversions = metrics.some((m) => (CONVERSION_METRIC_KEYS as readonly string[]).includes(m) || (DERIVED_METRIC_KEYS as readonly string[]).includes(m));
    const filters = Object.fromEntries(Object.entries(body.filters).filter(([, v]) => v.length > 0));
    const scope = analyticsScope(auth);

    const [clickRows, conversionRows] = await Promise.all([
      needsClicks
        ? runClickReport<Row>(this.deps.clickhouse, {
            scope,
            from: range.from,
            to: range.to,
            timezone: range.timezone,
            dimensions: clickDims,
            metrics: [...CLICK_METRIC_KEYS],
            filters: Object.fromEntries(Object.entries(filters).filter(([d]) => isFilterableClickDimension(d))) as Partial<Record<ClickDimension, string[]>>,
            limit: body.limit,
          })
        : Promise.resolve([] as Row[]),
      needsConversions ? runConversionReport(this.deps.clickhouse, { scope, from: range.from, to: range.to, timezone: range.timezone, dimensions: body.dimensions, filters, limit: body.limit }) : Promise.resolve([]),
    ]);

    const keyOf = (row: Row) => body.dimensions.map((d) => String(row[d] ?? '')).join('\u0001');
    const merged = new Map<string, Row>();
    for (const row of clickRows) merged.set(keyOf(row), { ...row });
    for (const row of conversionRows ?? []) merged.set(keyOf(row), { ...(merged.get(keyOf(row)) ?? Object.fromEntries(body.dimensions.map((d) => [d, row[d]]))), ...row });

    const rows = [...merged.values()].map((row) => {
      const full: Row = { ...row, ...computeDerived(row) };
      const output: Row = Object.fromEntries(body.dimensions.map((d) => [d, full[d]]));
      for (const metric of metrics) {
        const value = full[metric];
        output[metric] = value === undefined ? (conversionRows === null && (CONVERSION_METRIC_KEYS as readonly string[]).includes(metric) ? null : 0) : typeof value === 'string' && !['revenue', 'payout', 'sale_amount', 'profit', 'aov'].includes(metric) ? Number(value) : value;
      }
      return output;
    });
    rows.sort((a, b) => (body.dimensions[0] === 'date' || body.dimensions[0] === 'hour' ? String(a[body.dimensions[0]]).localeCompare(String(b[body.dimensions[0]])) : Number(b[metrics[0]!] ?? 0) - Number(a[metrics[0]!] ?? 0)));

    const names = await resolveEntityNames(this.deps.prisma, auth.organizationId, collectIds(rows));
    return { range, dimensions: body.dimensions, metrics, rows: attachNames(rows, names), conversionDimensionsSupported: conversionRows !== null };
  }

  toCsv(rows: Row[], columns: string[]): string {
    return toCsv(rows, columns);
  }
}
