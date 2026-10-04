import { describe, expect, it } from 'vitest';
import { resolveDateRange, zonedMidnight } from '../src/lib/date-range';

const now = new Date('2026-10-03T10:00:00Z');

describe('resolveDateRange', () => {
  it('aligns "today" to local midnight in a half-hour offset timezone (IST)', () => {
    const range = resolveDateRange({ preset: 'today' }, 'Asia/Kolkata', now);
    expect(range).toMatchObject({ fromDay: '2026-10-03', toDay: '2026-10-03', days: 1 });
    expect(range.from).toBe('2026-10-02T18:30:00.000Z');
    expect(range.to).toBe('2026-10-03T18:30:00.000Z');
  });

  it('computes the previous calendar month', () => {
    expect(resolveDateRange({ preset: 'previous_month' }, 'UTC', now)).toMatchObject({ fromDay: '2026-09-01', toDay: '2026-09-30', days: 30 });
  });

  it('lets a valid request timezone override the organization default', () => {
    expect(resolveDateRange({ preset: 'today', timezone: 'America/Los_Angeles' }, 'UTC', now).from).toBe('2026-10-03T07:00:00.000Z');
  });

  it('falls back to the organization timezone when the requested one is invalid', () => {
    expect(resolveDateRange({ preset: 'today', timezone: 'Mars/Base' }, 'UTC', now).timezone).toBe('UTC');
  });

  it('rejects custom ranges that are reversed or missing dates', () => {
    expect(() => resolveDateRange({ preset: 'custom', from: '2026-10-05', to: '2026-10-01' }, 'UTC', now)).toThrow();
    expect(() => resolveDateRange({ preset: 'custom' }, 'UTC', now)).toThrow();
  });
});

describe('zonedMidnight', () => {
  it('handles a DST transition day in Los Angeles', () => {
    expect(zonedMidnight('2026-03-08', 'America/Los_Angeles').toISOString()).toBe('2026-03-08T08:00:00.000Z');
    expect(zonedMidnight('2026-03-09', 'America/Los_Angeles').toISOString()).toBe('2026-03-09T07:00:00.000Z');
  });
});

describe('resolveDateRange: time of day', () => {
  const now = new Date('2026-10-05T06:00:00Z')
  it('narrows a single day to a local time window (end minute inclusive)', () => {
    const range = resolveDateRange({ preset: 'custom', from: '2026-10-04', to: '2026-10-04', fromTime: '10:00', toTime: '13:59', timezone: 'Asia/Kolkata' }, 'UTC', now)
    expect(range.from).toBe('2026-10-04T04:30:00.000Z')
    expect(range.to).toBe('2026-10-04T08:30:00.000Z')
  })
  it('applies the start time to the first day and the end time to the last day of a preset', () => {
    const range = resolveDateRange({ preset: 'yesterday', fromTime: '09:30', timezone: 'UTC' }, 'UTC', now)
    expect(range.from).toBe('2026-10-04T09:30:00.000Z')
    expect(range.to).toBe('2026-10-05T00:00:00.000Z')
  })
  it('rejects an end time before the start time', () => {
    expect(() => resolveDateRange({ preset: 'today', fromTime: '12:00', toTime: '11:00', timezone: 'UTC' }, 'UTC', now)).toThrow(/end time/)
  })
})
