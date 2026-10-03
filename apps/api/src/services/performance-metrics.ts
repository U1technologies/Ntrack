import type { AccessScope } from '../types';

/**
 * Metric catalogue for performance reports: raw click metrics (ClickHouse clicks), raw conversion
 * metrics (ClickHouse conversions) and derived ratios computed after the two are merged.
 */
export const CLICK_METRIC_KEYS = ['clicks', 'unique_clicks', 'valid_clicks', 'invalid_clicks', 'avg_latency_ms'] as const;
export const CONVERSION_METRIC_KEYS = ['conversions', 'approved_conversions', 'pending_conversions', 'rejected_conversions', 'revenue', 'payout', 'sale_amount'] as const;
export const DERIVED_METRIC_KEYS = ['profit', 'margin', 'epc', 'rpc', 'cr', 'roi', 'aov'] as const;
export const ALL_METRIC_KEYS = [...CLICK_METRIC_KEYS, ...CONVERSION_METRIC_KEYS, ...DERIVED_METRIC_KEYS] as const;
export type MetricKey = (typeof ALL_METRIC_KEYS)[number];

const NEEDS_REVENUE: MetricKey[] = ['revenue', 'profit', 'margin', 'rpc', 'roi'];
const NEEDS_PAYOUT: MetricKey[] = ['payout', 'profit', 'margin', 'epc', 'roi'];

/** Publishers never see revenue-based metrics; advertisers never see payout-based ones. */
export const allowedMetrics = (scope: AccessScope, canSeeRates: boolean, requested: MetricKey[]): MetricKey[] =>
  requested.filter((metric) => {
    if (scope.type === 'publisher' && NEEDS_REVENUE.includes(metric)) return false;
    if (scope.type === 'advertiser' && NEEDS_PAYOUT.includes(metric)) return false;
    if (!canSeeRates && scope.type !== 'publisher' && scope.type !== 'advertiser' && (NEEDS_REVENUE.includes(metric) || NEEDS_PAYOUT.includes(metric))) return false;
    return true;
  });

const num = (value: unknown) => (value === null || value === undefined || value === '' ? 0 : Number(value));
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const round = (value: number | null, digits = 4) => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);

/** Derived metrics from a merged row. Money stays as decimal strings with 2-6 dp from ClickHouse. */
export const computeDerived = (row: Record<string, unknown>) => {
  const clicks = num(row.clicks);
  const conversions = num(row.conversions);
  const revenue = num(row.revenue);
  const payout = num(row.payout);
  const withAmount = num(row.conversions_with_amount);
  return {
    profit: (revenue - payout).toFixed(2),
    margin: round(ratio(revenue - payout, revenue)),
    epc: round(ratio(payout, clicks)),
    rpc: round(ratio(revenue, clicks)),
    cr: round(ratio(conversions, clicks), 6),
    roi: round(ratio(revenue - payout, payout)),
    aov: withAmount > 0 ? (num(row.sale_amount) / withAmount).toFixed(2) : null,
  };
};
