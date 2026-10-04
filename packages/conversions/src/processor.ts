import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { findVisitorJourney, mirrorConversion, type ClickHouseClient } from '@ntrack/analytics';
import { Prisma, type Conversion, type PrismaClient } from '@ntrack/db';
import type { Notifier } from '@ntrack/notifications';
import { REDIS_KEYS, generatePublicId, startOfLocalDay, type ClickContext, type ConversionIntake, type PostbackEvent } from '@ntrack/shared';
import { computeCredits, winningTouch, ATTRIBUTION_MODEL_KEYS, type AttributionModelKey, type Touch } from './attribution';
import { dispatchPostbacks } from './dispatch';
import { evaluateIntakeFraud } from './fraud';
import { syncConversionLedger } from './ledger';
import { resolveRates } from './payout';

export interface ConversionDeps {
  prisma: PrismaClient;
  redis: Redis;
  clickhouse: ClickHouseClient;
  postbackQueue: Queue;
  /** Optional: cap and fraud alerts. Delivery failures never affect conversion processing. */
  notifier?: Notifier;
  log?: { warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
}

export type IngestResult =
  | { outcome: 'created'; conversion: Conversion }
  | { outcome: 'duplicate'; conversion: Conversion }
  | { outcome: 'rejected'; reason: RejectReason };

export type RejectReason = 'unknown_or_expired_click' | 'campaign_not_found' | 'outside_attribution_window' | 'click_cap_unavailable';

export class ConversionError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'invalid_transition' | 'invalid_state'
  ) {
    super(message);
  }
}

/** Allowed manual status transitions. Reversed is terminal (chargeback, refund). */
const TRANSITIONS: Record<Conversion['status'], Conversion['status'][]> = {
  pending: ['approved', 'rejected'],
  approved: ['rejected', 'reversed'],
  rejected: ['approved', 'pending'],
  reversed: [],
};

const isModel = (value: string): value is AttributionModelKey => (ATTRIBUTION_MODEL_KEYS as readonly string[]).includes(value);

/**
 * Conversion engine shared by the workers (postback/pixel stream) and the API (manual entry,
 * status changes, adjustments, attribution recalculation). PostgreSQL is the source of truth;
 * ClickHouse receives a mirrored row for reporting; postbacks are queued after commit.
 */
export class ConversionProcessor {
  constructor(private readonly deps: ConversionDeps) {}

  private get prisma() {
    return this.deps.prisma;
  }

  private async loadClick(clickId: string): Promise<ClickContext | null> {
    const raw = await this.deps.redis.get(REDIS_KEYS.click(clickId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ClickContext;
    } catch {
      return null;
    }
  }

  /** Clicks that compete for credit; always includes the converting click. */
  private async journey(click: ClickContext, advertiserId: string, model: AttributionModelKey, windowMs: number, conversionTs: number): Promise<Touch[]> {
    const own: Touch = { clickId: click.clickId, publisherId: click.publisherId, campaignId: click.campaignId, ts: click.ts, direct: !click.referrerDomain && !click.source };
    if (model === 'last_click' || !click.visitorId) return [own];
    try {
      const rows = await findVisitorJourney(this.deps.clickhouse, {
        organizationId: click.organizationId,
        advertiserId,
        visitorId: click.visitorId,
        from: conversionTs - windowMs,
        to: conversionTs,
      });
      const touches = rows.map<Touch>((row) => ({
        clickId: row.click_id,
        publisherId: row.publisher_id,
        campaignId: row.campaign_id,
        ts: Number(row.ts_ms),
        direct: !row.referrer_domain && !row.source,
      }));
      return touches.some((t) => t.clickId === own.clickId) ? touches : [...touches, own];
    } catch (error) {
      // Analytics outage must not lose the conversion: fall back to the converting click.
      this.deps.log?.warn({ err: error, clickId: click.clickId }, 'journey lookup failed; using last click');
      return [own];
    }
  }

  async ingest(intake: ConversionIntake): Promise<IngestResult> {
    const click = await this.loadClick(intake.clickId);
    if (!click) return { outcome: 'rejected', reason: 'unknown_or_expired_click' };

    const convertingCampaign = await this.prisma.campaign.findFirst({ where: { id: click.campaignId, organizationId: click.organizationId } });
    if (!convertingCampaign) return { outcome: 'rejected', reason: 'campaign_not_found' };

    const windowMs = convertingCampaign.attributionWindowHours * 3_600_000;
    if (intake.receivedAt - click.ts > windowMs) return { outcome: 'rejected', reason: 'outside_attribution_window' };

    const idempotencyKey = intake.transactionId ? `txn:${convertingCampaign.advertiserId}:${intake.transactionId}` : `clk:${click.clickId}:${intake.event}`;
    const existing = await this.prisma.conversion.findUnique({ where: { organizationId_idempotencyKey: { organizationId: click.organizationId, idempotencyKey } } });
    if (existing) {
      await this.prisma.conversionEvent.create({
        data: { organizationId: click.organizationId, conversionId: existing.id, type: 'duplicate_received', data: { source: intake.source, receivedAt: intake.receivedAt } },
      });
      return { outcome: 'duplicate', conversion: existing };
    }

    const model: AttributionModelKey = isModel(convertingCampaign.attributionModel) ? convertingCampaign.attributionModel : 'last_click';
    const touches = await this.journey(click, convertingCampaign.advertiserId, model, windowMs, intake.receivedAt);
    const credits = computeCredits(model, touches, intake.receivedAt);
    const winner = winningTouch(credits) ?? { clickId: click.clickId, publisherId: click.publisherId, campaignId: click.campaignId, ts: click.ts, direct: false };

    // Cross-campaign attribution: the credited click may belong to another campaign of the same advertiser.
    const campaign =
      winner.campaignId === convertingCampaign.id
        ? convertingCampaign
        : ((await this.prisma.campaign.findFirst({ where: { id: winner.campaignId, organizationId: click.organizationId, advertiserId: convertingCampaign.advertiserId } })) ??
          convertingCampaign);
    const publisherId = campaign.id === winner.campaignId ? winner.publisherId : click.publisherId;

    const tiers = await this.prisma.campaignPayout.findMany({ where: { campaignId: campaign.id }, include: { trafficSource: { select: { name: true } } } });
    const rates = resolveRates(
      tiers.map((t) => ({ ...t, payout: t.payout.toString(), revenue: t.revenue.toString(), trafficSourceName: t.trafficSource?.name ?? null })),
      { publisherId, trafficSource: click.source, country: click.country, deviceType: click.deviceType, event: intake.event, saleAmount: intake.saleAmount },
      { payout: campaign.defaultPayout.toString(), revenue: campaign.defaultRevenue.toString(), percentage: campaign.payoutModel === 'REVSHARE' }
    );

    const fraud = await evaluateIntakeFraud(this.prisma, click, intake.receivedAt);
    let status: Conversion['status'] = campaign.autoApproveConversions && click.isValid && !fraud.hold ? 'approved' : 'pending';
    let statusReason = click.isValid ? '' : `Click was flagged as invalid (${click.invalidReason || 'unknown'}); review required`;
    if (fraud.hold) statusReason = [statusReason, `Held for fraud review: ${fraud.reasons.join(' ')}`].filter(Boolean).join(' ');
    let conversionCapDay: string | null = null;
    if (campaign.dailyConversionCap) {
      const organization = await this.prisma.organization.findUniqueOrThrow({ where: { id: click.organizationId }, select: { timezone: true } });
      const today = await this.prisma.conversion.count({
        where: { campaignId: campaign.id, status: { in: ['pending', 'approved'] }, convertedAt: { gte: startOfLocalDay(new Date(intake.receivedAt), organization.timezone) } },
      });
      if (today >= campaign.dailyConversionCap) {
        status = 'rejected';
        statusReason = 'Daily conversion cap reached';
        conversionCapDay = startOfLocalDay(new Date(intake.receivedAt), organization.timezone).toISOString().slice(0, 10);
      }
    }

    let conversion: Conversion;
    try {
      conversion = await this.prisma.$transaction(async (tx) => {
        const created = await tx.conversion.create({
          data: {
            publicId: generatePublicId('cnv'),
            organizationId: click.organizationId,
            campaignId: campaign.id,
            publisherId,
            advertiserId: campaign.advertiserId,
            clickId: winner.clickId,
            linkId: winner.clickId === click.clickId ? click.linkId : null,
            domainId: winner.clickId === click.clickId ? click.domainId : null,
            event: intake.event,
            transactionId: intake.transactionId || null,
            idempotencyKey,
            source: intake.source,
            status,
            statusReason,
            currency: intake.currency || campaign.currency,
            saleAmount: intake.saleAmount,
            revenue: rates.revenue,
            payout: rates.payout,
            campaignPayoutId: rates.tierId,
            attributionModel: model,
            sub1: click.sub1,
            sub2: click.sub2,
            sub3: click.sub3,
            sub4: click.sub4,
            sub5: click.sub5,
            trafficSource: click.source,
            gaid: click.gaid ?? '',
            idfa: click.idfa ?? '',
            appName: click.appName ?? '',
            country: click.country,
            deviceType: click.deviceType,
            customParams: intake.customParams,
            clickedAt: new Date(winner.ts),
            convertedAt: new Date(intake.receivedAt),
            clickInvalid: !click.isValid,
          },
        });
        await tx.conversionEvent.create({
          data: {
            organizationId: click.organizationId,
            conversionId: created.id,
            type: 'created',
            actorUserId: intake.actorUserId ?? null,
            note: statusReason,
            data: JSON.parse(JSON.stringify({ source: intake.source, status, rates, convertingClickId: click.clickId, receivedAt: intake.receivedAt })) as Prisma.InputJsonValue,
          },
        });
        await tx.attributionEvent.createMany({
          data: credits.map((c, position) => ({
            organizationId: click.organizationId,
            conversionId: created.id,
            clickId: c.touch.clickId,
            publisherId: c.touch.publisherId,
            campaignId: c.touch.campaignId,
            model,
            position,
            credit: c.credit.toFixed(6),
            clickedAt: new Date(c.touch.ts),
            direct: c.touch.direct,
          })),
        });
        if (fraud.events.length) {
          await tx.fraudEvent.createMany({
            data: fraud.events.map((e) => ({
              organizationId: click.organizationId,
              ruleId: e.ruleId,
              type: e.type,
              severity: e.severity,
              riskScore: e.riskScore,
              publisherId,
              campaignId: campaign.id,
              clickId: click.clickId,
              conversionId: created.id,
              reason: e.reason,
              details: e.details as Prisma.InputJsonValue,
              dedupeKey: `${e.ruleId}:conversion:${created.id}`,
            })),
            skipDuplicates: true,
          });
        }
        return syncConversionLedger(tx, created, intake.actorUserId);
      });
    } catch (error) {
      // A concurrent duplicate won the unique index race.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const duplicate = await this.prisma.conversion.findUniqueOrThrow({ where: { organizationId_idempotencyKey: { organizationId: click.organizationId, idempotencyKey } } });
        return { outcome: 'duplicate', conversion: duplicate };
      }
      throw error;
    }

    await this.afterChange(conversion, status === 'approved' ? ['conversion.created', 'conversion.approved'] : ['conversion.created']);
    if (conversionCapDay) {
      this.deps.notifier?.emit({
        organizationId: click.organizationId,
        type: 'cap.reached',
        title: `Daily conversion cap reached: ${campaign.name}`,
        body: `${campaign.name} reached its daily conversion cap of ${campaign.dailyConversionCap}. Further conversions today are rejected.`,
        link: `/ntrack/campaigns/${campaign.id}`,
        subject: { advertiserId: campaign.advertiserId },
        dedupeKey: `cap:conversions:${campaign.id}:${conversionCapDay}`,
        dedupeTtlSeconds: 2 * 86_400,
      });
    }
    if (fraud.events.length > 0) {
      this.deps.notifier?.emit({
        organizationId: click.organizationId,
        type: 'fraud.alert',
        title: `Conversion held for fraud review: ${campaign.name}`,
        body: fraud.reasons.join(' '),
        link: '/ntrack/fraud',
        subject: { advertiserId: campaign.advertiserId, publisherId },
        // One alert per campaign and publisher per hour; the review queue lists every event.
        dedupeKey: `fraud:conversion:${campaign.id}:${publisherId}`,
        dedupeTtlSeconds: 3600,
      });
    }
    return { outcome: 'created', conversion };
  }

  private async afterChange(conversion: Conversion, events: PostbackEvent[]) {
    await mirrorConversion(this.deps.clickhouse, conversion).catch((error) =>
      this.deps.log?.error({ err: error, conversionId: conversion.id }, 'failed to mirror conversion to ClickHouse')
    );
    for (const event of events) await dispatchPostbacks(this.deps, conversion, event);
  }

  private async find(organizationId: string, id: string) {
    const conversion = await this.prisma.conversion.findFirst({ where: { id, organizationId } });
    if (!conversion) throw new ConversionError('Conversion not found', 'not_found');
    return conversion;
  }

  async changeStatus(organizationId: string, id: string, status: Conversion['status'], actorUserId: string, note: string) {
    const before = await this.find(organizationId, id);
    if (!TRANSITIONS[before.status].includes(status)) {
      throw new ConversionError(`Cannot change a ${before.status} conversion to ${status}`, 'invalid_transition');
    }
    const after = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.conversion.update({ where: { id }, data: { status, statusReason: note } });
      await tx.conversionEvent.create({ data: { organizationId, conversionId: id, type: status, actorUserId, note, data: { from: before.status, to: status } } });
      return syncConversionLedger(tx, updated, actorUserId);
    });
    const STATUS_EVENTS: Partial<Record<Conversion['status'], PostbackEvent>> = {
      approved: 'conversion.approved',
      rejected: 'conversion.rejected',
      reversed: 'conversion.reversed',
    };
    const event = STATUS_EVENTS[status];
    await this.afterChange(after, event ? [event] : []);
    return after;
  }

  /** Corrections are new events on the conversion, never silent edits. */
  async adjust(organizationId: string, id: string, values: { payout?: string; revenue?: string; saleAmount?: string }, actorUserId: string, note: string) {
    const before = await this.find(organizationId, id);
    if (before.status === 'reversed') throw new ConversionError('Reversed conversions cannot be adjusted', 'invalid_state');
    const after = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.conversion.update({ where: { id }, data: { payout: values.payout, revenue: values.revenue, saleAmount: values.saleAmount } });
      await tx.conversionEvent.create({
        data: {
          organizationId,
          conversionId: id,
          type: 'adjusted',
          actorUserId,
          note,
          data: {
            before: { payout: before.payout.toString(), revenue: before.revenue.toString(), saleAmount: before.saleAmount?.toString() ?? null },
            after: { payout: updated.payout.toString(), revenue: updated.revenue.toString(), saleAmount: updated.saleAmount?.toString() ?? null },
          },
        },
      });
      return syncConversionLedger(tx, updated, actorUserId);
    });
    await this.afterChange(after, ['conversion.adjusted']);
    return after;
  }

  /**
   * Recomputes credits under a model and stores them as a new version. Payouts are not changed
   * automatically (that is a financial decision); the result shows which publisher would win.
   */
  async recalculateAttribution(organizationId: string, id: string, model: AttributionModelKey, actorUserId: string) {
    const conversion = await this.find(organizationId, id);
    const current = await this.prisma.attributionEvent.findMany({ where: { conversionId: id }, orderBy: [{ version: 'desc' }, { position: 'asc' }] });
    const version = (current[0]?.version ?? 0) + 1;
    const latest = current.filter((e) => e.version === current[0]?.version);
    const touches: Touch[] = latest.map((e) => ({ clickId: e.clickId, publisherId: e.publisherId, campaignId: e.campaignId, ts: e.clickedAt.getTime(), direct: e.direct }));
    const credits = computeCredits(model, touches, conversion.convertedAt.getTime());
    await this.prisma.$transaction([
      this.prisma.attributionEvent.createMany({
        data: credits.map((c, position) => ({
          organizationId,
          conversionId: id,
          clickId: c.touch.clickId,
          publisherId: c.touch.publisherId,
          campaignId: c.touch.campaignId,
          model,
          position,
          credit: c.credit.toFixed(6),
          clickedAt: new Date(c.touch.ts),
          direct: c.touch.direct,
          version,
        })),
      }),
      this.prisma.conversionEvent.create({ data: { organizationId, conversionId: id, type: 'attribution_recalculated', actorUserId, data: { model, version } } }),
    ]);
    return { version, model, credits: credits.map((c) => ({ clickId: c.touch.clickId, publisherId: c.touch.publisherId, credit: c.credit })), winner: winningTouch(credits) };
  }
}
