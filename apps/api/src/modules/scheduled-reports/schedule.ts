import { localDay, zonedMidnight } from '@ntrack/shared';

export interface ScheduleSpec {
  frequency: 'daily' | 'weekly';
  /** ISO weekday, Monday = 1 … Sunday = 7. Weekly only. */
  weekday: number | null;
  hourLocal: number;
  lastRunAt: Date | null;
}

/** ISO weekday (1-7) of a YYYY-MM-DD calendar date. */
const isoWeekday = (day: string): number => {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
};

/** The instant today's run is due in `timeZone`, or null when it does not run today. */
export const scheduledInstantToday = (spec: Pick<ScheduleSpec, 'frequency' | 'weekday' | 'hourLocal'>, timeZone: string, now: Date): Date | null => {
  const today = localDay(now, timeZone);
  if (spec.frequency === 'weekly' && isoWeekday(today) !== spec.weekday) return null;
  // Adding hours to local midnight is DST-safe except within the transition hour itself, which is acceptable for reports.
  return new Date(zonedMidnight(today, timeZone).getTime() + spec.hourLocal * 3_600_000);
};

/** Due once per scheduled slot: the slot has passed and the report has not run since. */
export const isReportDue = (spec: ScheduleSpec, timeZone: string, now: Date = new Date()): boolean => {
  const slot = scheduledInstantToday(spec, timeZone, now);
  if (!slot || now < slot) return false;
  return !spec.lastRunAt || spec.lastRunAt < slot;
};
