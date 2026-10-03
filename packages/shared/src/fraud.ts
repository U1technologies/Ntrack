/** Fraud rule catalogue shared by the API (defaults, validation), workers (detection) and console. */
export const FRAUD_RULE_TYPES = ['fast_conversion', 'click_burst', 'invalid_click_ratio', 'conversion_rate_spike', 'repeated_transaction'] as const;
export type FraudRuleType = (typeof FRAUD_RULE_TYPES)[number];

export const FRAUD_RULE_DESCRIPTIONS: Record<FraudRuleType, { label: string; threshold: string; window: string }> = {
  fast_conversion: { label: 'Conversion too soon after the click', threshold: 'Minimum seconds between click and conversion', window: 'Not used' },
  click_burst: { label: 'Click burst on one link', threshold: 'Clicks on one link within the window', window: 'Window (minutes)' },
  invalid_click_ratio: { label: 'High share of invalid clicks', threshold: 'Invalid share (0-1), e.g. 0.5 = 50%', window: 'Window (minutes)' },
  conversion_rate_spike: { label: 'Unusually high conversion rate', threshold: 'Conversion rate (0-1), e.g. 0.3 = 30%', window: 'Window (minutes)' },
  repeated_transaction: { label: 'Same transaction ID sent repeatedly', threshold: 'Duplicate postbacks for one conversion', window: 'Window (minutes)' },
};

export const DEFAULT_FRAUD_RULES: Array<{ name: string; type: FraudRuleType; threshold: number; windowMinutes: number; minVolume: number; severity: 'low' | 'medium' | 'high'; action: 'flag' | 'hold' }> = [
  { name: 'Conversion within 10 seconds of click', type: 'fast_conversion', threshold: 10, windowMinutes: 0, minVolume: 0, severity: 'high', action: 'hold' },
  { name: 'Click burst: 120+ clicks on a link in 5 minutes', type: 'click_burst', threshold: 120, windowMinutes: 5, minVolume: 0, severity: 'medium', action: 'flag' },
  { name: 'Over 50% invalid clicks in an hour (100+ clicks)', type: 'invalid_click_ratio', threshold: 0.5, windowMinutes: 60, minVolume: 100, severity: 'medium', action: 'flag' },
  { name: 'Conversion rate above 30% in a day (50+ clicks)', type: 'conversion_rate_spike', threshold: 0.3, windowMinutes: 1440, minVolume: 50, severity: 'medium', action: 'flag' },
  { name: 'Same transaction sent 3+ times in an hour', type: 'repeated_transaction', threshold: 3, windowMinutes: 60, minVolume: 0, severity: 'low', action: 'flag' },
];

const BASE: Record<string, number> = { low: 30, medium: 60, high: 85 };

/** 0-100 score: severity base plus up to 15 points for how far the observation exceeds the threshold. */
export const fraudRiskScore = (severity: string, observed: number, threshold: number, higherIsWorse = true): number => {
  const base = BASE[severity] ?? 50;
  if (!threshold) return base;
  const excess = higherIsWorse ? observed / threshold - 1 : 1 - observed / threshold;
  return Math.min(100, Math.round(base + Math.max(0, Math.min(1, excess)) * 15));
};
