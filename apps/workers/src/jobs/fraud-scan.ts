import type { ClickHouseClient } from '@ntrack/analytics';
import { toClickHouseDateTime } from '@ntrack/analytics';
import { prisma, type FraudRule, type Prisma } from '@ntrack/db';
import { fraudRiskScore } from '@ntrack/shared';
import type { Logger } from '../logger';

interface Finding {
  publisherId?: string;
  campaignId?: string;
  entityKey: string;
  observed: number;
  reason: string;
  details: Record<string, unknown>;
}

const query = async <T>(clickhouse: ClickHouseClient, sql: string, params: Record<string, unknown>) =>
  (await clickhouse.query({ query: sql, query_params: params, format: 'JSONEachRow' })).json<T>();

/** One detector per rule type; each returns explainable findings for the rule's window. */
const detectors: Record<string, (rule: FraudRule, clickhouse: ClickHouseClient, from: Date) => Promise<Finding[]>> = {
  click_burst: async (rule, clickhouse, from) => {
    const rows = await query<{ link_id: string; publisher_id: string; campaign_id: string; clicks: string }>(
      clickhouse,
      `SELECT toString(link_id) AS link_id, toString(publisher_id) AS publisher_id, toString(campaign_id) AS campaign_id, count() AS clicks
       FROM clicks WHERE organization_id = {org:UUID} AND ts >= {from:DateTime64(3)}
       GROUP BY link_id, publisher_id, campaign_id HAVING clicks >= {threshold:UInt64}`,
      { org: rule.organizationId, from: toClickHouseDateTime(from.getTime()), threshold: Math.ceil(Number(rule.threshold)) }
    );
    return rows.map((r) => ({
      publisherId: r.publisher_id,
      campaignId: r.campaign_id,
      entityKey: `link:${r.link_id}`,
      observed: Number(r.clicks),
      reason: `${r.clicks} clicks on one tracking link in ${rule.windowMinutes} minutes (rule: ${Number(rule.threshold)}+).`,
      details: { linkId: r.link_id, clicks: Number(r.clicks), windowMinutes: rule.windowMinutes },
    }));
  },

  invalid_click_ratio: async (rule, clickhouse, from) => {
    const rows = await query<{ publisher_id: string; clicks: string; invalid: string }>(
      clickhouse,
      `SELECT toString(publisher_id) AS publisher_id, count() AS clicks, countIf(is_valid = 0) AS invalid
       FROM clicks WHERE organization_id = {org:UUID} AND ts >= {from:DateTime64(3)}
       GROUP BY publisher_id HAVING clicks >= {minVolume:UInt64} AND invalid / clicks >= {threshold:Float64}`,
      { org: rule.organizationId, from: toClickHouseDateTime(from.getTime()), minVolume: rule.minVolume, threshold: Number(rule.threshold) }
    );
    return rows.map((r) => {
      const ratio = Number(r.invalid) / Number(r.clicks);
      return {
        publisherId: r.publisher_id,
        entityKey: `publisher:${r.publisher_id}`,
        observed: ratio,
        reason: `${(ratio * 100).toFixed(1)}% of ${r.clicks} clicks were invalid (bots, duplicates, targeting) in ${rule.windowMinutes} minutes (rule: ${(Number(rule.threshold) * 100).toFixed(0)}%+).`,
        details: { clicks: Number(r.clicks), invalid: Number(r.invalid), ratio },
      };
    });
  },

  conversion_rate_spike: async (rule, clickhouse, from) => {
    const conversions = await prisma.conversion.groupBy({
      by: ['publisherId', 'campaignId'],
      where: { organizationId: rule.organizationId, convertedAt: { gte: from }, status: { in: ['pending', 'approved'] } },
      _count: { _all: true },
    });
    if (conversions.length === 0) return [];
    const clicks = await query<{ publisher_id: string; campaign_id: string; clicks: string }>(
      clickhouse,
      `SELECT toString(publisher_id) AS publisher_id, toString(campaign_id) AS campaign_id, count() AS clicks
       FROM clicks WHERE organization_id = {org:UUID} AND ts >= {from:DateTime64(3)} AND is_valid = 1 GROUP BY publisher_id, campaign_id`,
      { org: rule.organizationId, from: toClickHouseDateTime(from.getTime()) }
    );
    return conversions.flatMap((c) => {
      const clickCount = Number(clicks.find((k) => k.publisher_id === c.publisherId && k.campaign_id === c.campaignId)?.clicks ?? 0);
      if (clickCount < rule.minVolume || clickCount === 0) return [];
      const rate = c._count._all / clickCount;
      if (rate < Number(rule.threshold)) return [];
      return [
        {
          publisherId: c.publisherId,
          campaignId: c.campaignId,
          entityKey: `publisher:${c.publisherId}:campaign:${c.campaignId}`,
          observed: rate,
          reason: `Conversion rate ${(rate * 100).toFixed(1)}% (${c._count._all} conversions / ${clickCount} valid clicks) in ${Math.round(rule.windowMinutes / 60)}h (rule: ${(Number(rule.threshold) * 100).toFixed(0)}%+).`,
          details: { conversions: c._count._all, clicks: clickCount, rate },
        },
      ];
    });
  },

  repeated_transaction: async (rule, _clickhouse, from) => {
    const duplicates = await prisma.conversionEvent.groupBy({
      by: ['conversionId'],
      where: { organizationId: rule.organizationId, type: 'duplicate_received', createdAt: { gte: from } },
      _count: { _all: true },
      having: { conversionId: { _count: { gte: Math.ceil(Number(rule.threshold)) } } },
    });
    if (duplicates.length === 0) return [];
    const conversions = await prisma.conversion.findMany({ where: { id: { in: duplicates.map((d) => d.conversionId) } }, select: { id: true, publicId: true, publisherId: true, campaignId: true, transactionId: true } });
    return conversions.map((c) => {
      const count = duplicates.find((d) => d.conversionId === c.id)?._count._all ?? 0;
      return {
        publisherId: c.publisherId,
        campaignId: c.campaignId,
        entityKey: `conversion:${c.id}`,
        observed: count,
        reason: `Transaction ${c.transactionId ?? c.publicId} was sent ${count} more times after it was recorded (rule: ${Number(rule.threshold)}+). Check the advertiser integration or replay attempts.`,
        details: { conversionId: c.id, duplicates: count },
      };
    });
  },
};

/**
 * Runs every active scheduled rule. Findings are de-duplicated per rule, entity and window bucket,
 * so a long-running pattern raises one event per window instead of one per scan.
 */
export interface FraudScanEvent {
  organizationId: string;
  ruleId: string;
  reason: string;
  severity: string;
  publisherId: string | null;
  campaignId: string | null;
}

export const runFraudScan = async (clickhouse: ClickHouseClient, log: Logger, onEvent?: (event: FraudScanEvent) => Promise<void>) => {
  const rules = await prisma.fraudRule.findMany({ where: { active: true, type: { in: Object.keys(detectors) } } });
  let created = 0;
  for (const rule of rules) {
    const windowMs = Math.max(1, rule.windowMinutes) * 60_000;
    const from = new Date(Date.now() - windowMs);
    const bucket = Math.floor(Date.now() / windowMs);
    let findings: Finding[] = [];
    try {
      findings = await detectors[rule.type]!(rule, clickhouse, from);
    } catch (error) {
      log.error({ err: error, ruleId: rule.id }, 'fraud detector failed');
      continue;
    }
    for (const finding of findings) {
      const result = await prisma.fraudEvent.createMany({
        data: [
          {
            organizationId: rule.organizationId,
            ruleId: rule.id,
            type: rule.type,
            severity: rule.severity,
            riskScore: fraudRiskScore(rule.severity, finding.observed, Number(rule.threshold)),
            publisherId: finding.publisherId ?? null,
            campaignId: finding.campaignId ?? null,
            reason: finding.reason,
            details: finding.details as Prisma.InputJsonValue,
            dedupeKey: `${rule.id}:${finding.entityKey}:${bucket}`,
          },
        ],
        skipDuplicates: true,
      });
      if (result.count) {
        created += 1;
        await onEvent?.({
          organizationId: rule.organizationId,
          ruleId: rule.id,
          reason: finding.reason,
          severity: rule.severity,
          publisherId: finding.publisherId ?? null,
          campaignId: finding.campaignId ?? null,
        });
      }
    }
  }
  return { rules: rules.length, created };
};
