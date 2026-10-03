import { describe, expect, it } from 'vitest';
import { isReportDue } from '../src/modules/scheduled-reports/schedule';

const daily = { frequency: 'daily' as const, weekday: null, hourLocal: 8, lastRunAt: null };

describe('isReportDue', () => {
  it('is not due before the local send hour', () => {
    // 07:30 in Kolkata = 02:00 UTC.
    expect(isReportDue(daily, 'Asia/Kolkata', new Date('2026-10-05T02:00:00Z'))).toBe(false);
  });

  it('becomes due at the local send hour and stays due until it has run', () => {
    expect(isReportDue(daily, 'Asia/Kolkata', new Date('2026-10-05T02:31:00Z'))).toBe(true);
    expect(isReportDue(daily, 'Asia/Kolkata', new Date('2026-10-05T09:00:00Z'))).toBe(true);
  });

  it('does not run twice for the same slot', () => {
    const ranAt = new Date('2026-10-05T02:35:00Z');
    expect(isReportDue({ ...daily, lastRunAt: ranAt }, 'Asia/Kolkata', new Date('2026-10-05T10:00:00Z'))).toBe(false);
    // Next day's slot is due again.
    expect(isReportDue({ ...daily, lastRunAt: ranAt }, 'Asia/Kolkata', new Date('2026-10-06T02:31:00Z'))).toBe(true);
  });

  it('runs weekly reports only on the chosen local weekday', () => {
    const weekly = { frequency: 'weekly' as const, weekday: 1, hourLocal: 9, lastRunAt: null };
    // Monday 05 Oct 2026 09:30 in Los Angeles = 16:30 UTC.
    expect(isReportDue(weekly, 'America/Los_Angeles', new Date('2026-10-05T16:30:00Z'))).toBe(true);
    expect(isReportDue(weekly, 'America/Los_Angeles', new Date('2026-10-06T16:30:00Z'))).toBe(false);
  });
});
