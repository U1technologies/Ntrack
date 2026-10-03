/**
 * Payout tier resolution. The most specific active tier that matches the conversion wins;
 * specificity weights reflect how deliberate the rule is (a publisher deal beats a country rule).
 * Ties go to the higher priority, then the older tier. No match: campaign defaults.
 */

export interface TierLike {
  id: string;
  publisherId: string | null;
  trafficSourceId: string | null;
  trafficSourceName?: string | null;
  country: string | null;
  deviceType: string | null;
  event: string | null;
  payout: string;
  revenue: string;
  isPercentage: boolean;
  priority: number;
  active: boolean;
  createdAt: Date;
}

export interface PayoutContext {
  publisherId: string;
  trafficSource: string;
  country: string;
  deviceType: string;
  event: string;
  saleAmount: string | null;
}

export interface ResolvedRates {
  payout: string;
  revenue: string;
  tierId: string | null;
}

const WEIGHTS = { publisher: 16, trafficSource: 8, country: 4, device: 2, event: 1 };

const matches = (tier: TierLike, ctx: PayoutContext) =>
  tier.active &&
  (!tier.publisherId || tier.publisherId === ctx.publisherId) &&
  (!tier.trafficSourceId || (tier.trafficSourceName ?? '').toLowerCase() === ctx.trafficSource.toLowerCase()) &&
  (!tier.country || tier.country === ctx.country.toUpperCase()) &&
  (!tier.deviceType || tier.deviceType === ctx.deviceType) &&
  (!tier.event || tier.event === ctx.event);

const specificity = (tier: TierLike) =>
  (tier.publisherId ? WEIGHTS.publisher : 0) +
  (tier.trafficSourceId ? WEIGHTS.trafficSource : 0) +
  (tier.country ? WEIGHTS.country : 0) +
  (tier.deviceType ? WEIGHTS.device : 0) +
  (tier.event ? WEIGHTS.event : 0);

/** Decimal-safe percentage: works on integer micro-units to avoid float drift. */
const percentOf = (amount: string, percent: string): string => {
  const toMicros = (value: string) => {
    const [whole = '0', fraction = ''] = value.split('.');
    return BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
  };
  const micros = (toMicros(amount) * toMicros(percent)) / 100_000_000n;
  const whole = micros / 1_000_000n;
  const fraction = (micros % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${fraction}`;
};

export const resolveRates = (
  tiers: TierLike[],
  ctx: PayoutContext,
  defaults: { payout: string; revenue: string; percentage: boolean }
): ResolvedRates => {
  const best = tiers
    .filter((tier) => matches(tier, ctx))
    .sort((a, b) => specificity(b) - specificity(a) || b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime())[0];

  const pick = (fixed: string, isPercentage: boolean) => (isPercentage ? (ctx.saleAmount ? percentOf(ctx.saleAmount, fixed) : '0') : fixed);

  if (best) return { payout: pick(best.payout, best.isPercentage), revenue: pick(best.revenue, best.isPercentage), tierId: best.id };
  return { payout: pick(defaults.payout, defaults.percentage), revenue: pick(defaults.revenue, defaults.percentage), tierId: null };
};
