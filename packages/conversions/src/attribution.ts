/**
 * Attribution models. Input: the visitor's clicks on the advertiser's campaigns inside the
 * attribution window (oldest first), including the converting click. Output: credit per click
 * (sums to 1). The click with the highest credit receives the payout; credits are stored for
 * reporting and audit.
 */

export const ATTRIBUTION_MODEL_KEYS = ['last_click', 'first_click', 'last_non_direct', 'position_based', 'time_decay'] as const;
export type AttributionModelKey = (typeof ATTRIBUTION_MODEL_KEYS)[number];

export interface Touch {
  clickId: string;
  publisherId: string;
  campaignId: string;
  ts: number;
  /** Direct = no referrer and no declared source. */
  direct: boolean;
}

export interface Credit {
  touch: Touch;
  credit: number;
}

const HALF_LIFE_DAYS = 7;

const normalise = (credits: Credit[]): Credit[] => {
  const total = credits.reduce((sum, c) => sum + c.credit, 0);
  return total > 0 ? credits.map((c) => ({ ...c, credit: c.credit / total })) : credits;
};

export const computeCredits = (model: AttributionModelKey, touches: Touch[], conversionTs: number): Credit[] => {
  const ordered = [...touches].sort((a, b) => a.ts - b.ts);
  if (ordered.length === 0) return [];
  if (ordered.length === 1) return [{ touch: ordered[0]!, credit: 1 }];
  const last = ordered.length - 1;

  switch (model) {
    case 'first_click':
      return ordered.map((touch, i) => ({ touch, credit: i === 0 ? 1 : 0 }));
    case 'last_non_direct': {
      let index = last;
      for (let i = last; i >= 0; i -= 1) {
        if (!ordered[i]!.direct) {
          index = i;
          break;
        }
      }
      return ordered.map((touch, i) => ({ touch, credit: i === index ? 1 : 0 }));
    }
    case 'position_based': {
      // 40% first, 40% last, 20% shared by the middle touches (50/50 with two touches).
      if (ordered.length === 2) return ordered.map((touch) => ({ touch, credit: 0.5 }));
      const middleShare = 0.2 / (ordered.length - 2);
      return ordered.map((touch, i) => ({ touch, credit: i === 0 || i === last ? 0.4 : middleShare }));
    }
    case 'time_decay':
      return normalise(
        ordered.map((touch) => {
          const ageDays = Math.max(0, conversionTs - touch.ts) / 86_400_000;
          return { touch, credit: Math.pow(0.5, ageDays / HALF_LIFE_DAYS) };
        })
      );
    case 'last_click':
    default:
      return ordered.map((touch, i) => ({ touch, credit: i === last ? 1 : 0 }));
  }
};

/** The credited touch: highest credit, latest click on ties (the converting click under last-click). */
export const winningTouch = (credits: Credit[]): Touch | null =>
  credits.reduce<Credit | null>((best, c) => (!best || c.credit > best.credit || (c.credit === best.credit && c.touch.ts > best.touch.ts) ? c : best), null)?.touch ?? null;
