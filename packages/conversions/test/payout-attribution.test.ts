import { describe, expect, it } from 'vitest';
import { computeCredits, winningTouch, type Touch } from '../src/attribution';
import { resolveRates, type TierLike } from '../src/payout';

const tier = (overrides: Partial<TierLike>): TierLike => ({
  id: 't',
  publisherId: null,
  trafficSourceId: null,
  trafficSourceName: null,
  country: null,
  deviceType: null,
  event: null,
  payout: '1',
  revenue: '2',
  isPercentage: false,
  priority: 0,
  active: true,
  createdAt: new Date('2026-01-01'),
  ...overrides,
});
const ctx = { publisherId: 'pubA', trafficSource: 'search', country: 'US', deviceType: 'mobile', event: 'sale', saleAmount: '200.00' };
const defaults = { payout: '5', revenue: '7', percentage: false };

describe('resolveRates', () => {
  it('falls back to campaign defaults when no tier matches', () => {
    expect(resolveRates([tier({ publisherId: 'other' })], ctx, defaults)).toEqual({ payout: '5', revenue: '7', tierId: null });
  });

  it('prefers a publisher tier over a country tier (Publisher A $6 beats US $5.50)', () => {
    const rates = resolveRates([tier({ id: 'us', country: 'US', payout: '5.50' }), tier({ id: 'pubA', publisherId: 'pubA', payout: '6' })], ctx, defaults);
    expect(rates).toMatchObject({ payout: '6', tierId: 'pubA' });
  });

  it('uses priority to break ties between equally specific tiers', () => {
    const rates = resolveRates([tier({ id: 'low', country: 'US', priority: 1 }), tier({ id: 'high', country: 'US', priority: 5 })], ctx, defaults);
    expect(rates.tierId).toBe('high');
  });

  it('ignores inactive tiers and tiers for other devices', () => {
    expect(resolveRates([tier({ active: false, publisherId: 'pubA' }), tier({ deviceType: 'desktop' })], ctx, defaults).tierId).toBeNull();
  });

  it('computes RevShare percentages exactly from the sale amount', () => {
    expect(resolveRates([tier({ id: 'rs', isPercentage: true, payout: '12.5', revenue: '20' })], ctx, defaults)).toEqual({ payout: '25.000000', revenue: '40.000000', tierId: 'rs' });
    expect(resolveRates([tier({ isPercentage: true, payout: '10' })], { ...ctx, saleAmount: null }, defaults).payout).toBe('0');
  });
});

const day = 86_400_000;
const touches: Touch[] = [
  { clickId: 'a', publisherId: 'p1', campaignId: 'c', ts: 0, direct: false },
  { clickId: 'b', publisherId: 'p2', campaignId: 'c', ts: 5 * day, direct: false },
  { clickId: 'c', publisherId: 'p3', campaignId: 'c', ts: 9 * day, direct: true },
];

describe('computeCredits', () => {
  it('gives everything to the last click by default', () => {
    expect(winningTouch(computeCredits('last_click', touches, 10 * day))?.clickId).toBe('c');
  });

  it('gives everything to the first click', () => {
    expect(winningTouch(computeCredits('first_click', touches, 10 * day))?.clickId).toBe('a');
  });

  it('skips direct clicks for last non-direct', () => {
    expect(winningTouch(computeCredits('last_non_direct', touches, 10 * day))?.clickId).toBe('b');
  });

  it('splits 40/20/40 for position-based', () => {
    expect(computeCredits('position_based', touches, 10 * day).map((c) => c.credit)).toEqual([0.4, 0.2, 0.4]);
  });

  it('weights recent clicks higher under time decay and sums to 1', () => {
    const credits = computeCredits('time_decay', touches, 10 * day);
    expect(credits[2]!.credit).toBeGreaterThan(credits[0]!.credit);
    expect(credits.reduce((s, c) => s + c.credit, 0)).toBeCloseTo(1, 10);
  });

  it('handles a single touch', () => {
    expect(computeCredits('position_based', [touches[0]!], day)).toEqual([{ touch: touches[0], credit: 1 }]);
  });
});
