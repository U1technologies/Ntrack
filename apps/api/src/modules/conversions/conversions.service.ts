import type { z } from 'zod';
import { ConversionError } from '@ntrack/conversions';
import type { Conversion, Prisma } from '@ntrack/db';
import { resolveDateRange } from '../../lib/date-range';
import { AppError } from '../../lib/errors';
import { paginated } from '../../lib/response';
import { serialize } from '../../lib/serialize';
import { conversionWhere, isAdvertiserPortal, isPublisherPortal } from '../../services/access-scope';
import { writeAudit } from '../../services/audit';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';
import type { AdjustBody, BulkStatusBody, CreateConversionBody, ListConversionsQuery, StatusChangeBody } from './conversions.schemas';

const listInclude = {
  campaign: { select: { id: true, name: true, publicId: true } },
  publisher: { select: { id: true, companyName: true, publicId: true } },
  advertiser: { select: { id: true, companyName: true } },
} satisfies Prisma.ConversionInclude;

/** Publishers never see revenue; advertisers never see publisher payouts. */
const present = <T extends Partial<Conversion>>(conversion: T, auth: OrgAuthContext) => {
  const output: Record<string, unknown> = serialize(conversion);
  if (isPublisherPortal(auth.scope) || !auth.permissions.has('payouts.view')) delete output.revenue;
  if (isAdvertiserPortal(auth.scope)) delete output.payout;
  return output;
};

const translate = (error: unknown): never => {
  if (error instanceof ConversionError) {
    throw error.code === 'not_found' ? AppError.notFound('Conversion') : AppError.conflict(error.message);
  }
  throw error;
};

export class ConversionsService {
  constructor(private readonly deps: AppDeps) {}

  private whereFor(auth: OrgAuthContext, query: z.infer<typeof ListConversionsQuery>): Prisma.ConversionWhereInput {
    const range = resolveDateRange(query, auth.organizationTimezone);
    return {
      organizationId: auth.organizationId,
      ...conversionWhere(auth.scope),
      convertedAt: { gte: new Date(range.from), lt: new Date(range.to) },
      ...(query.status ? { status: query.status } : {}),
      ...(query.campaignId ? { campaignId: query.campaignId } : {}),
      ...(query.publisherId ? { publisherId: query.publisherId } : {}),
      ...(query.advertiserId ? { advertiserId: query.advertiserId } : {}),
      ...(query.event ? { event: query.event } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.search ? { OR: [{ publicId: query.search }, { clickId: query.search.toUpperCase() }, { transactionId: query.search }] } : {}),
    };
  }

  async list(auth: OrgAuthContext, query: z.infer<typeof ListConversionsQuery>) {
    const where = this.whereFor(auth, query);
    const [items, total, totals] = await Promise.all([
      this.deps.prisma.conversion.findMany({ where, include: listInclude, orderBy: { convertedAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.deps.prisma.conversion.count({ where }),
      this.deps.prisma.conversion.groupBy({ by: ['status'], where, _count: { _all: true }, _sum: { payout: true, revenue: true } }),
    ]);
    const summary = totals.map((t) => present({ status: t.status, count: t._count._all, payout: t._sum.payout, revenue: t._sum.revenue } as never, auth));
    return { ...paginated(items.map((c) => present(c, auth)), total, query.page, query.pageSize), summary };
  }

  async get(auth: OrgAuthContext, id: string) {
    const conversion = await this.deps.prisma.conversion.findFirst({
      where: { id, organizationId: auth.organizationId, ...conversionWhere(auth.scope) },
      include: {
        ...listInclude,
        events: { orderBy: { createdAt: 'asc' } },
        attributions: { orderBy: [{ version: 'desc' }, { position: 'asc' }] },
        deliveries: auth.permissions.has('postbacks.view') ? { orderBy: { createdAt: 'desc' }, take: 20, include: { postback: { select: { name: true } } } } : false,
      },
    });
    if (!conversion) throw AppError.notFound('Conversion');
    const users = await this.deps.prisma.user.findMany({
      where: { id: { in: conversion.events.flatMap((e) => (e.actorUserId ? [e.actorUserId] : [])) } },
      select: { id: true, name: true, email: true },
    });
    const output = present(conversion, auth);
    output.events = conversion.events.map((e) => ({ ...e, actor: users.find((u) => u.id === e.actorUserId) ?? null }));
    // Attribution and payout tiers are network-internal.
    if (isPublisherPortal(auth.scope) || isAdvertiserPortal(auth.scope)) {
      delete output.attributions;
      delete output.campaignPayoutId;
    }
    return output;
  }

  /** Manual / API entry runs through the same engine as postbacks (dedup, window, payout, attribution). */
  async create(auth: OrgAuthContext, input: z.infer<typeof CreateConversionBody>, meta: RequestMeta) {
    const result = await this.deps.conversions.ingest({
      source: 'manual',
      clickId: input.clickId,
      event: input.event,
      transactionId: input.transactionId,
      saleAmount: input.saleAmount ?? null,
      currency: input.currency ?? '',
      customParams: input.note ? { note: input.note } : {},
      receivedAt: Date.now(),
      actorUserId: auth.user.id,
    });
    if (result.outcome === 'rejected') throw AppError.badRequest(`Conversion rejected: ${result.reason.replace(/_/g, ' ')}`);
    if (result.conversion.organizationId !== auth.organizationId) throw AppError.notFound('Click');
    if (result.outcome === 'duplicate') throw AppError.conflict(`Duplicate of conversion ${result.conversion.publicId}`);
    await writeAudit(this.deps.prisma, auth, meta, { action: 'conversion.created_manually', entityType: 'conversion', entityId: result.conversion.id, summary: input.clickId });
    return present(result.conversion, auth);
  }

  private async assertAccess(auth: OrgAuthContext, id: string) {
    const exists = await this.deps.prisma.conversion.findFirst({ where: { id, organizationId: auth.organizationId, ...conversionWhere(auth.scope) }, select: { id: true } });
    if (!exists) throw AppError.notFound('Conversion');
  }

  async changeStatus(auth: OrgAuthContext, id: string, input: z.infer<typeof StatusChangeBody>, meta: RequestMeta) {
    await this.assertAccess(auth, id);
    const updated = await this.deps.conversions.changeStatus(auth.organizationId, id, input.status, auth.user.id, input.note).catch(translate);
    await writeAudit(this.deps.prisma, auth, meta, { action: `conversion.${input.status}`, entityType: 'conversion', entityId: id, summary: input.note });
    this.notifyReviewed(auth, updated.publisherId, input.status, 1, input.note);
    return present(updated, auth);
  }

  async bulkStatus(auth: OrgAuthContext, input: z.infer<typeof BulkStatusBody>, meta: RequestMeta) {
    const results = { updated: 0, skipped: [] as Array<{ id: string; reason: string }> };
    const perPublisher = new Map<string, number>();
    for (const id of input.ids) {
      try {
        await this.assertAccess(auth, id);
        const updated = await this.deps.conversions.changeStatus(auth.organizationId, id, input.status, auth.user.id, input.note);
        perPublisher.set(updated.publisherId, (perPublisher.get(updated.publisherId) ?? 0) + 1);
        results.updated += 1;
      } catch (error) {
        results.skipped.push({ id, reason: (error as Error).message });
      }
    }
    await writeAudit(this.deps.prisma, auth, meta, { action: `conversion.bulk_${input.status}`, entityType: 'conversion', summary: `${results.updated} updated, ${results.skipped.length} skipped` });
    // One summary per publisher instead of one notification per conversion.
    for (const [publisherId, count] of perPublisher) this.notifyReviewed(auth, publisherId, input.status, count, input.note);
    return results;
  }

  /** Tells the publisher how many of their conversions changed status. Never includes amounts. */
  private notifyReviewed(auth: OrgAuthContext, publisherId: string, status: string, count: number, note: string | undefined) {
    const noun = count === 1 ? 'conversion was' : `${count} conversions were`;
    this.deps.notifier.emit({
      organizationId: auth.organizationId,
      type: 'conversion.reviewed',
      title: `${count === 1 ? 'A' : ''} ${noun} ${status}`.trim(),
      body: note ?? '',
      link: '/ntrack/conversions',
      subject: { publisherId },
      actorUserId: auth.user.id,
    });
  }

  async adjust(auth: OrgAuthContext, id: string, input: z.infer<typeof AdjustBody>, meta: RequestMeta) {
    await this.assertAccess(auth, id);
    if (!auth.permissions.has('payouts.manage') && (input.payout !== undefined || input.revenue !== undefined)) throw AppError.forbidden('Adjusting rates requires the payout management permission');
    const updated = await this.deps.conversions
      .adjust(auth.organizationId, id, { payout: input.payout, revenue: input.revenue, saleAmount: input.saleAmount }, auth.user.id, input.note)
      .catch(translate);
    await writeAudit(this.deps.prisma, auth, meta, { action: 'conversion.adjusted', entityType: 'conversion', entityId: id, summary: input.note, after: input });
    return present(updated, auth);
  }

  async recalculate(auth: OrgAuthContext, id: string, model: Parameters<AppDeps['conversions']['recalculateAttribution']>[2], meta: RequestMeta) {
    await this.assertAccess(auth, id);
    const result = await this.deps.conversions.recalculateAttribution(auth.organizationId, id, model, auth.user.id).catch(translate);
    await writeAudit(this.deps.prisma, auth, meta, { action: 'attribution.recalculated', entityType: 'conversion', entityId: id, summary: model });
    return result;
  }

  async exportCsv(auth: OrgAuthContext, query: z.infer<typeof ListConversionsQuery>) {
    const items = await this.deps.prisma.conversion.findMany({ where: this.whereFor(auth, query), include: listInclude, orderBy: { convertedAt: 'desc' }, take: 50_000 });
    const showRevenue = !isPublisherPortal(auth.scope) && auth.permissions.has('payouts.view');
    const showPayout = !isAdvertiserPortal(auth.scope);
    const columns = ['conversion_id', 'converted_at', 'status', 'event', 'campaign', 'publisher', 'click_id', 'transaction_id', 'currency', 'sale_amount', ...(showPayout ? ['payout'] : []), ...(showRevenue ? ['revenue'] : []), 'sub1', 'country', 'source'];
    const escape = (value: unknown) => {
      const text = value === null || value === undefined ? '' : String(value);
      return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
    };
    const rows = items.map((c) =>
      [
        c.publicId,
        c.convertedAt.toISOString(),
        c.status,
        c.event,
        c.campaign.name,
        c.publisher.companyName,
        c.clickId,
        c.transactionId,
        c.currency,
        c.saleAmount?.toString(),
        ...(showPayout ? [c.payout.toString()] : []),
        ...(showRevenue ? [c.revenue.toString()] : []),
        c.sub1,
        c.country,
        c.source,
      ]
        .map(escape)
        .join(',')
    );
    return [columns.join(','), ...rows].join('\n');
  }
}
