import { z } from 'zod';
import { localDay, zonedMidnight } from '@ntrack/shared';
import { AppError } from './errors';

export { zonedMidnight };

export const DATE_PRESETS = ['today', 'yesterday', 'last_7_days', 'last_30_days', 'this_month', 'previous_month', 'custom'] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const DateRangeQuery = z.object({
  preset: z.enum(DATE_PRESETS).default('last_7_days'),
  /** Local calendar dates (YYYY-MM-DD) in `timezone`, inclusive. Required for custom. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timezone: z.string().max(64).optional(),
  /** Optional time of day (HH:MM, local) for the start of the first day and the end of the last day (inclusive minute). */
  fromTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM').optional(),
  toTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM').optional(),
});
export type DateRangeQuery = z.infer<typeof DateRangeQuery>;

const addDays = (day: string, days: number): string => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

export const isValidTimezone = (timeZone: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
};

export interface ResolvedRange {
  from: string;
  to: string;
  fromDay: string;
  toDay: string;
  timezone: string;
  days: number;
}

/** Resolves a preset or custom range into UTC [from, to) bounds aligned to local midnights. */
export const resolveDateRange = (query: DateRangeQuery, fallbackTimezone: string, now = new Date()): ResolvedRange => {
  const timezone = query.timezone && isValidTimezone(query.timezone) ? query.timezone : fallbackTimezone;
  const today = localDay(now, timezone);
  let fromDay: string;
  let toDay: string;
  switch (query.preset) {
    case 'today':
      fromDay = toDay = today;
      break;
    case 'yesterday':
      fromDay = toDay = addDays(today, -1);
      break;
    case 'last_30_days':
      fromDay = addDays(today, -29);
      toDay = today;
      break;
    case 'this_month':
      fromDay = `${today.slice(0, 8)}01`;
      toDay = today;
      break;
    case 'previous_month': {
      const firstOfThis = `${today.slice(0, 8)}01`;
      toDay = addDays(firstOfThis, -1);
      fromDay = `${toDay.slice(0, 8)}01`;
      break;
    }
    case 'custom':
      if (!query.from || !query.to) throw AppError.badRequest('Custom ranges need from and to dates');
      fromDay = query.from;
      toDay = query.to;
      break;
    default:
      fromDay = addDays(today, -6);
      toDay = today;
  }
  if (fromDay > toDay) throw AppError.badRequest('The start date must be before the end date');
  const days = Math.round((Date.parse(toDay) - Date.parse(fromDay)) / 86_400_000) + 1;
  if (days > 400) throw AppError.badRequest('Ranges are limited to 400 days');
  // Times are offsets from local midnight; on a daylight-saving change day they can be off by the shift.
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const from = new Date(zonedMidnight(fromDay, timezone).getTime() + (query.fromTime ? minutes(query.fromTime) * 60_000 : 0));
  const to = query.toTime
    ? new Date(zonedMidnight(toDay, timezone).getTime() + (minutes(query.toTime) + 1) * 60_000)
    : zonedMidnight(addDays(toDay, 1), timezone);
  if (to <= from) throw AppError.badRequest('The end time must be after the start time');
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    fromDay,
    toDay,
    timezone,
    days,
  };
};
