import type { ClickHouseClient } from '@clickhouse/client';
import type { ClickEvent } from '@ntrack/shared';

export interface ClickEnrichment {
  os: string;
  browser: string;
}

export interface ClickRow {
  click_id: string;
  ts: string;
  organization_id: string;
  campaign_id: string;
  publisher_id: string;
  advertiser_id: string;
  link_id: string;
  domain_id: string;
  landing_page_id: string;
  sub1: string;
  sub2: string;
  sub3: string;
  sub4: string;
  sub5: string;
  source: string;
  external_click_id: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_term: string;
  utm_content: string;
  country: string;
  region: string;
  city: string;
  device_type: string;
  os: string;
  browser: string;
  user_agent: string;
  ip: string;
  visitor_id: string;
  referrer: string;
  referrer_domain: string;
  destination_url: string;
  is_unique: number;
  is_valid: number;
  invalid_reason: string;
  redirect_mode: string;
  latency_ms: number;
}

/** ClickHouse DateTime64(3) accepts 'YYYY-MM-DD hh:mm:ss.sss' in UTC. */
export const toClickHouseDateTime = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

export const toClickRow = (event: ClickEvent, enrichment: ClickEnrichment): ClickRow => ({
  click_id: event.clickId,
  ts: toClickHouseDateTime(event.ts),
  organization_id: event.organizationId,
  campaign_id: event.campaignId,
  publisher_id: event.publisherId,
  advertiser_id: event.advertiserId,
  link_id: event.linkId,
  domain_id: event.domainId,
  landing_page_id: event.landingPageId,
  sub1: event.sub1,
  sub2: event.sub2,
  sub3: event.sub3,
  sub4: event.sub4,
  sub5: event.sub5,
  source: event.source,
  external_click_id: event.externalClickId,
  utm_source: event.utmSource,
  utm_medium: event.utmMedium,
  utm_campaign: event.utmCampaign,
  utm_term: event.utmTerm,
  utm_content: event.utmContent,
  country: event.country,
  region: event.region,
  city: event.city,
  device_type: event.deviceType,
  os: enrichment.os,
  browser: enrichment.browser,
  user_agent: event.userAgent,
  ip: event.ip,
  visitor_id: event.visitorId ?? '',
  referrer: event.referrer,
  referrer_domain: event.referrerDomain,
  destination_url: event.destinationUrl,
  is_unique: event.isUnique ? 1 : 0,
  is_valid: event.isValid ? 1 : 0,
  invalid_reason: event.invalidReason,
  redirect_mode: event.redirectMode,
  latency_ms: Math.max(0, Math.round(event.latencyMs)),
});

/**
 * Inserts one batch. `dedupToken` must be stable for the batch (e.g. first-last stream IDs) so a
 * retried batch after a worker crash is dropped by ClickHouse instead of double counted.
 */
export const insertClickBatch = async (client: ClickHouseClient, rows: ClickRow[], dedupToken: string): Promise<void> => {
  if (rows.length === 0) return;
  await client.insert({
    table: 'clicks',
    values: rows,
    format: 'JSONEachRow',
    clickhouse_settings: { insert_deduplication_token: dedupToken, insert_deduplicate: 1 },
  });
};
