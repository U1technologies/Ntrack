const formatters = new Map<string, Intl.DateTimeFormat>();

/** Calendar day (YYYY-MM-DD) in the campaign's timezone, used for daily cap counters. */
export const dayKey = (now: number, timezone: string): string => {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
    }
    formatters.set(timezone, formatter);
  }
  return formatter.format(now);
};
