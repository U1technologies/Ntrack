import type { ClickHouseClient } from '@clickhouse/client';
import { toClickHouseDateTime } from './clicks';

export interface ConversionRow {
  conversion_id: string;
  organization_id: string;
  campaign_id: string;
  publisher_id: string;
  advertiser_id: string;
  click_id: string;
  link_id: string;
  domain_id: string;
  event: string;
  status: string;
  source: string;
  currency: string;
  sale_amount: string;
  revenue: string;
  payout: string;
  sub1: string;
  sub2: string;
  sub3: string;
  sub4: string;
  sub5: string;
  traffic_source: string;
  country: string;
  device_type: string;
  clicked_at: string;
  converted_at: string;
  version: number;
}

export interface ConversionMirrorInput {
  id: string;
  organizationId: string;
  campaignId: string;
  publisherId: string;
  advertiserId: string;
  clickId: string;
  linkId: string | null;
  domainId: string | null;
  event: string;
  status: string;
  source: string;
  currency: string;
  saleAmount: { toString(): string } | null;
  revenue: { toString(): string };
  payout: { toString(): string };
  sub1: string;
  sub2: string;
  sub3: string;
  sub4: string;
  sub5: string;
  trafficSource: string;
  country: string;
  deviceType: string;
  clickedAt: Date;
  convertedAt: Date;
  updatedAt: Date;
}

let versionCounter = 0;

/** Upserts the reporting copy of a conversion (latest version wins under ReplacingMergeTree). */
export const mirrorConversion = async (client: ClickHouseClient, c: ConversionMirrorInput): Promise<void> => {
  const row: ConversionRow = {
    conversion_id: c.id,
    organization_id: c.organizationId,
    campaign_id: c.campaignId,
    publisher_id: c.publisherId,
    advertiser_id: c.advertiserId,
    click_id: c.clickId,
    link_id: c.linkId ?? '',
    domain_id: c.domainId ?? '',
    event: c.event,
    status: c.status,
    source: c.source,
    currency: c.currency,
    sale_amount: c.saleAmount?.toString() ?? '0',
    revenue: c.revenue.toString(),
    payout: c.payout.toString(),
    sub1: c.sub1,
    sub2: c.sub2,
    sub3: c.sub3,
    sub4: c.sub4,
    sub5: c.sub5,
    traffic_source: c.trafficSource,
    country: c.country,
    device_type: c.deviceType,
    clicked_at: toClickHouseDateTime(c.clickedAt.getTime()),
    converted_at: toClickHouseDateTime(c.convertedAt.getTime()),
    // Millisecond timestamp plus a per-process counter so two updates in the same millisecond still order.
    version: c.updatedAt.getTime() * 1000 + (versionCounter++ % 1000),
  };
  await client.insert({ table: 'conversions', values: [row], format: 'JSONEachRow' });
};

export interface JourneyClick {
  click_id: string;
  campaign_id: string;
  publisher_id: string;
  link_id: string;
  domain_id: string;
  ts_ms: string;
  referrer_domain: string;
  source: string;
  country: string;
  device_type: string;
  sub1: string;
  sub2: string;
  sub3: string;
  sub4: string;
  sub5: string;
}

/** Valid clicks by the same visitor on any of the advertiser's campaigns inside the window. */
export const findVisitorJourney = async (
  client: ClickHouseClient,
  params: { organizationId: string; advertiserId: string; visitorId: string; from: number; to: number; limit?: number }
): Promise<JourneyClick[]> => {
  if (!params.visitorId) return [];
  const result = await client.query({
    query: `SELECT click_id, toString(campaign_id) AS campaign_id, toString(publisher_id) AS publisher_id, toString(link_id) AS link_id,
                   toString(domain_id) AS domain_id, toString(toUnixTimestamp64Milli(ts)) AS ts_ms, referrer_domain, source, country,
                   device_type, sub1, sub2, sub3, sub4, sub5
            FROM clicks
            WHERE organization_id = {org:UUID} AND advertiser_id = {adv:UUID} AND visitor_id = {visitor:String}
              AND ts >= {from:DateTime64(3)} AND ts <= {to:DateTime64(3)} AND is_valid = 1
            ORDER BY ts ASC
            LIMIT {limit:UInt32}`,
    query_params: {
      org: params.organizationId,
      adv: params.advertiserId,
      visitor: params.visitorId,
      from: toClickHouseDateTime(params.from),
      to: toClickHouseDateTime(params.to),
      limit: params.limit ?? 50,
    },
    format: 'JSONEachRow',
  });
  return result.json<JourneyClick>();
};
