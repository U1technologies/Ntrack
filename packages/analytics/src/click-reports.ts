import type { ClickHouseClient } from '@clickhouse/client';

/**
 * Click reporting query builder. Dimensions, metrics and filters come from fixed registries, and
 * every user-supplied value is bound as a ClickHouse query parameter, so report requests can
 * never inject SQL. Tenant isolation is enforced here: organization_id is always the first
 * predicate and data-level scopes (advertiser/publisher restrictions) are mandatory inputs.
 */

export const CLICK_DIMENSIONS = {
  date: { expr: 'toDate(ts, {tz:String})', type: 'date' },
  hour: { expr: "formatDateTime(toStartOfHour(toTimeZone(ts, {tz:String})), '%Y-%m-%d %H:00')", type: 'string' },
  campaign: { expr: 'toString(campaign_id)', type: 'uuid' },
  publisher: { expr: 'toString(publisher_id)', type: 'uuid' },
  advertiser: { expr: 'toString(advertiser_id)', type: 'uuid' },
  domain: { expr: 'toString(domain_id)', type: 'uuid' },
  link: { expr: 'toString(link_id)', type: 'uuid' },
  landing_page: { expr: 'landing_page_id', type: 'string' },
  country: { expr: 'country', type: 'string' },
  device: { expr: 'device_type', type: 'string' },
  os: { expr: 'os', type: 'string' },
  browser: { expr: 'browser', type: 'string' },
  source: { expr: 'source', type: 'string' },
  referrer_domain: { expr: 'referrer_domain', type: 'string' },
  sub1: { expr: 'sub1', type: 'string' },
  sub2: { expr: 'sub2', type: 'string' },
  sub3: { expr: 'sub3', type: 'string' },
  sub4: { expr: 'sub4', type: 'string' },
  sub5: { expr: 'sub5', type: 'string' },
  invalid_reason: { expr: 'invalid_reason', type: 'string' },
} as const;
export type ClickDimension = keyof typeof CLICK_DIMENSIONS;

export const CLICK_METRICS = {
  clicks: 'count()',
  unique_clicks: 'sum(is_unique)',
  valid_clicks: 'sum(is_valid)',
  invalid_clicks: 'count() - sum(is_valid)',
  avg_latency_ms: 'round(avg(latency_ms), 1)',
} as const;
export type ClickMetric = keyof typeof CLICK_METRICS;

/** Columns that can be filtered with equality/IN; uuid columns are compared as UUID. */
const FILTER_COLUMNS: Partial<Record<ClickDimension, { column: string; type: 'UUID' | 'String' }>> = {
  campaign: { column: 'campaign_id', type: 'UUID' },
  publisher: { column: 'publisher_id', type: 'UUID' },
  advertiser: { column: 'advertiser_id', type: 'UUID' },
  domain: { column: 'domain_id', type: 'UUID' },
  link: { column: 'link_id', type: 'UUID' },
  landing_page: { column: 'landing_page_id', type: 'String' },
  country: { column: 'country', type: 'String' },
  device: { column: 'device_type', type: 'String' },
  os: { column: 'os', type: 'String' },
  browser: { column: 'browser', type: 'String' },
  source: { column: 'source', type: 'String' },
  sub1: { column: 'sub1', type: 'String' },
  sub2: { column: 'sub2', type: 'String' },
  sub3: { column: 'sub3', type: 'String' },
  sub4: { column: 'sub4', type: 'String' },
  sub5: { column: 'sub5', type: 'String' },
  invalid_reason: { column: 'invalid_reason', type: 'String' },
};

export const isClickDimension = (value: string): value is ClickDimension => value in CLICK_DIMENSIONS;
export const isClickMetric = (value: string): value is ClickMetric => value in CLICK_METRICS;
export const isFilterableClickDimension = (value: string): boolean => value in FILTER_COLUMNS;

/** Mandatory data-level scope. Empty arrays mean "no restriction" only when `restricted` is false. */
export interface DataScope {
  organizationId: string;
  restricted: boolean;
  advertiserIds: string[];
  publisherIds: string[];
}

export interface ClickReportRequest {
  scope: DataScope;
  /** Inclusive start / exclusive end, ISO strings in UTC. */
  from: string;
  to: string;
  timezone: string;
  dimensions: ClickDimension[];
  metrics: ClickMetric[];
  filters?: Partial<Record<ClickDimension, string[]>>;
  onlyValid?: boolean;
  sort?: { field: ClickDimension | ClickMetric; direction: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
}

export interface BuiltQuery {
  query: string;
  params: Record<string, unknown>;
}

const toChDateTime = (iso: string) => new Date(iso).toISOString().replace('T', ' ').replace('Z', '');

const buildWhere = (request: Pick<ClickReportRequest, 'scope' | 'from' | 'to' | 'filters' | 'onlyValid'>) => {
  const { scope } = request;
  const clauses = ['organization_id = {org:UUID}', 'ts >= {from:DateTime64(3)}', 'ts < {to:DateTime64(3)}'];
  const params: Record<string, unknown> = {
    org: scope.organizationId,
    from: toChDateTime(request.from),
    to: toChDateTime(request.to),
  };

  if (scope.restricted) {
    // A restricted user with no assignments must see nothing, not everything.
    if (scope.advertiserIds.length === 0 && scope.publisherIds.length === 0) clauses.push('0');
    const parts: string[] = [];
    if (scope.advertiserIds.length > 0) {
      parts.push('advertiser_id IN {scopeAdv:Array(UUID)}');
      params.scopeAdv = scope.advertiserIds;
    }
    if (scope.publisherIds.length > 0) {
      parts.push('publisher_id IN {scopePub:Array(UUID)}');
      params.scopePub = scope.publisherIds;
    }
    if (parts.length > 0) clauses.push(`(${parts.join(' OR ')})`);
  }

  Object.entries(request.filters ?? {}).forEach(([dimension, values], index) => {
    const filter = FILTER_COLUMNS[dimension as ClickDimension];
    if (!filter || !values || values.length === 0) return;
    clauses.push(`${filter.column} IN {f${index}:Array(${filter.type})}`);
    params[`f${index}`] = values;
  });

  if (request.onlyValid) clauses.push('is_valid = 1');
  return { where: clauses.join(' AND '), params };
};

export const buildClickReportQuery = (request: ClickReportRequest): BuiltQuery => {
  const dimensions = request.dimensions.filter(isClickDimension);
  const metrics = (request.metrics.length > 0 ? request.metrics : (['clicks'] as ClickMetric[])).filter(isClickMetric);
  const { where, params } = buildWhere(request);
  params.tz = request.timezone;

  const select = [
    ...dimensions.map((dimension) => `${CLICK_DIMENSIONS[dimension].expr} AS ${dimension}`),
    ...metrics.map((metric) => `${CLICK_METRICS[metric]} AS ${metric}`),
  ];

  let query = `SELECT ${select.join(', ')} FROM clicks WHERE ${where}`;
  if (dimensions.length > 0) query += ` GROUP BY ${dimensions.join(', ')}`;

  const sortField = request.sort?.field;
  if (sortField && (dimensions.includes(sortField as ClickDimension) || metrics.includes(sortField as ClickMetric))) {
    query += ` ORDER BY ${sortField} ${request.sort?.direction === 'asc' ? 'ASC' : 'DESC'}`;
  } else if (dimensions.includes('date') || dimensions.includes('hour')) {
    query += ` ORDER BY ${dimensions.includes('date') ? 'date' : 'hour'} ASC`;
  } else if (metrics.length > 0) {
    query += ` ORDER BY ${metrics[0]} DESC`;
  }

  const limit = Math.min(Math.max(request.limit ?? 100, 1), 10_000);
  const offset = Math.max(request.offset ?? 0, 0);
  query += ` LIMIT ${limit} OFFSET ${offset}`;
  return { query, params };
};

export const runClickReport = async <T extends Record<string, unknown>>(
  client: ClickHouseClient,
  request: ClickReportRequest
): Promise<T[]> => {
  const { query, params } = buildClickReportQuery(request);
  const result = await client.query({ query, query_params: params, format: 'JSONEachRow' });
  return result.json<T>();
};

export interface ClickLogRequest {
  scope: DataScope;
  from: string;
  to: string;
  filters?: Partial<Record<ClickDimension, string[]>>;
  clickId?: string;
  onlyInvalid?: boolean;
  limit: number;
  offset: number;
}

const CLICK_LOG_COLUMNS = [
  'click_id',
  "formatDateTime(ts, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS clicked_at",
  'toString(campaign_id) AS campaign_id',
  'toString(publisher_id) AS publisher_id',
  'toString(advertiser_id) AS advertiser_id',
  'toString(domain_id) AS domain_id',
  'toString(link_id) AS link_id',
  'sub1',
  'sub2',
  'sub3',
  'sub4',
  'sub5',
  'source',
  'country',
  'region',
  'city',
  'device_type',
  'os',
  'browser',
  'ip',
  'referrer_domain',
  'destination_url',
  'is_unique',
  'is_valid',
  'invalid_reason',
  'redirect_mode',
  'latency_ms',
];

export const runClickLog = async <T extends Record<string, unknown>>(client: ClickHouseClient, request: ClickLogRequest) => {
  const { where, params } = buildWhere(request);
  let fullWhere = where;
  if (request.clickId) {
    fullWhere += ' AND click_id = {clickId:String}';
    params.clickId = request.clickId;
  }
  if (request.onlyInvalid) fullWhere += ' AND is_valid = 0';
  const limit = Math.min(Math.max(request.limit, 1), 500);
  const offset = Math.max(request.offset, 0);

  const [rows, count] = await Promise.all([
    client
      .query({
        query: `SELECT ${CLICK_LOG_COLUMNS.join(', ')} FROM clicks WHERE ${fullWhere} ORDER BY ts DESC LIMIT ${limit} OFFSET ${offset}`,
        query_params: params,
        format: 'JSONEachRow',
      })
      .then((result) => result.json<T>()),
    client
      .query({ query: `SELECT count() AS total FROM clicks WHERE ${fullWhere}`, query_params: params, format: 'JSONEachRow' })
      .then((result) => result.json<{ total: string }>()),
  ]);
  return { rows, total: Number(count[0]?.total ?? 0) };
};
