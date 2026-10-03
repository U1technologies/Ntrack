import type { ClickHouseClient } from '@clickhouse/client';
import type { ClickDimension, DataScope } from './click-reports';

/**
 * Conversion side of reports. Same safety rules as click reports: fixed registries, bound
 * parameters, mandatory tenant scope. Reads `conversions FINAL` so status changes are reflected.
 * "Gross" amounts count pending + approved conversions; rejected and reversed are excluded.
 */

const CONVERSION_DIMENSIONS: Partial<Record<ClickDimension | 'event' | 'status' | 'conversion_source', string>> = {
  date: 'toDate(c.converted_at, {tz:String})',
  hour: "formatDateTime(toStartOfHour(toTimeZone(c.converted_at, {tz:String})), '%Y-%m-%d %H:00')",
  campaign: 'toString(c.campaign_id)',
  publisher: 'toString(c.publisher_id)',
  advertiser: 'toString(c.advertiser_id)',
  domain: 'c.domain_id',
  country: 'c.country',
  device: 'c.device_type',
  source: 'c.traffic_source',
  sub1: 'c.sub1',
  sub2: 'c.sub2',
  sub3: 'c.sub3',
  sub4: 'c.sub4',
  sub5: 'c.sub5',
  event: 'c.event',
  status: 'c.status',
  conversion_source: 'c.source',
};

export type ConversionDimension = keyof typeof CONVERSION_DIMENSIONS;

export const isConversionDimension = (value: string): value is ConversionDimension => value in CONVERSION_DIMENSIONS;

// Columns are qualified with the table alias `c` because metric aliases (revenue, payout, ...)
// would otherwise shadow the columns of the same name inside other aggregates.
const GROSS = "c.status IN ('pending', 'approved')";

export const CONVERSION_METRICS = {
  conversions: 'countIf(' + GROSS + ')',
  approved_conversions: "countIf(c.status = 'approved')",
  pending_conversions: "countIf(c.status = 'pending')",
  rejected_conversions: "countIf(c.status IN ('rejected', 'reversed'))",
  revenue: `toString(sumIf(c.revenue, ${GROSS}))`,
  approved_revenue: "toString(sumIf(c.revenue, c.status = 'approved'))",
  payout: `toString(sumIf(c.payout, ${GROSS}))`,
  approved_payout: "toString(sumIf(c.payout, c.status = 'approved'))",
  sale_amount: `toString(sumIf(c.sale_amount, ${GROSS}))`,
  conversions_with_amount: `countIf(${GROSS} AND c.sale_amount > 0)`,
} as const;
export type ConversionMetric = keyof typeof CONVERSION_METRICS;

const FILTER_COLUMNS: Partial<Record<string, { column: string; type: 'UUID' | 'String' }>> = {
  campaign: { column: 'campaign_id', type: 'UUID' },
  publisher: { column: 'publisher_id', type: 'UUID' },
  advertiser: { column: 'advertiser_id', type: 'UUID' },
  domain: { column: 'domain_id', type: 'String' },
  country: { column: 'country', type: 'String' },
  device: { column: 'device_type', type: 'String' },
  source: { column: 'traffic_source', type: 'String' },
  sub1: { column: 'sub1', type: 'String' },
  sub2: { column: 'sub2', type: 'String' },
  sub3: { column: 'sub3', type: 'String' },
  sub4: { column: 'sub4', type: 'String' },
  sub5: { column: 'sub5', type: 'String' },
  event: { column: 'event', type: 'String' },
  status: { column: 'status', type: 'String' },
};

export interface ConversionReportRequest {
  scope: DataScope;
  from: string;
  to: string;
  timezone: string;
  dimensions: string[];
  filters?: Record<string, string[]>;
  limit?: number;
}

const toChDateTime = (iso: string) => new Date(iso).toISOString().replace('T', ' ').replace('Z', '');

/** Returns null when a requested dimension does not exist on conversions (e.g. browser). */
export const buildConversionReportQuery = (request: ConversionReportRequest) => {
  if (!request.dimensions.every(isConversionDimension)) return null;
  const { scope } = request;
  const clauses = ['c.organization_id = {org:UUID}', 'c.converted_at >= {from:DateTime64(3)}', 'c.converted_at < {to:DateTime64(3)}'];
  const params: Record<string, unknown> = { org: scope.organizationId, from: toChDateTime(request.from), to: toChDateTime(request.to), tz: request.timezone };

  if (scope.restricted) {
    const parts: string[] = [];
    if (scope.advertiserIds.length) {
      parts.push('c.advertiser_id IN {scopeAdv:Array(UUID)}');
      params.scopeAdv = scope.advertiserIds;
    }
    if (scope.publisherIds.length) {
      parts.push('c.publisher_id IN {scopePub:Array(UUID)}');
      params.scopePub = scope.publisherIds;
    }
    clauses.push(parts.length ? `(${parts.join(' OR ')})` : '0');
  }
  Object.entries(request.filters ?? {}).forEach(([dimension, values], index) => {
    const filter = FILTER_COLUMNS[dimension];
    if (!filter || values.length === 0) return;
    clauses.push(`c.${filter.column} IN {f${index}:Array(${filter.type})}`);
    params[`f${index}`] = values;
  });

  const dims = request.dimensions as ConversionDimension[];
  const select = [
    ...dims.map((d) => `${CONVERSION_DIMENSIONS[d]} AS ${d}`),
    ...Object.entries(CONVERSION_METRICS).map(([name, expr]) => `${expr} AS ${name}`),
  ];
  let query = `SELECT ${select.join(', ')} FROM conversions AS c FINAL WHERE ${clauses.join(' AND ')}`;
  if (dims.length) query += ` GROUP BY ${dims.join(', ')}`;
  query += ` LIMIT ${Math.min(Math.max(request.limit ?? 1000, 1), 10_000)}`;
  return { query, params };
};

export type ConversionReportRow = Record<string, string | number>;

export const runConversionReport = async (client: ClickHouseClient, request: ConversionReportRequest): Promise<ConversionReportRow[] | null> => {
  const built = buildConversionReportQuery(request);
  if (!built) return null;
  const result = await client.query({ query: built.query, query_params: built.params, format: 'JSONEachRow' });
  return result.json<ConversionReportRow>();
};
