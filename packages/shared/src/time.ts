/** Timezone helpers shared by the API (report ranges) and conversion processing (daily caps). */

/** Offset in ms between UTC and `timeZone` at instant `date` (positive east of UTC). */
export const timezoneOffsetMs = (date: Date, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
};

/** UTC instant of local midnight for a YYYY-MM-DD date in `timeZone` (DST-safe). */
export const zonedMidnight = (day: string, timeZone: string): Date => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const guess = new Date(Date.UTC(y, m - 1, d));
  const first = new Date(guess.getTime() - timezoneOffsetMs(guess, timeZone));
  return new Date(guess.getTime() - timezoneOffsetMs(first, timeZone));
};

export const localDay = (date: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

/** Start of the local day containing `date`. */
export const startOfLocalDay = (date: Date, timeZone: string): Date => zonedMidnight(localDay(date, timeZone), timeZone);
