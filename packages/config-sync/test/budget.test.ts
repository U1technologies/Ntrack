import { describe, expect, it } from 'vitest';
import { Prisma } from '@ntrack/db';
import { isBudgetExhausted, startOfLocalMonth } from '../src/budget';

const budget = (monthly: number | null, total: number | null) => ({
  monthlyBudget: monthly === null ? null : new Prisma.Decimal(monthly),
  totalBudget: total === null ? null : new Prisma.Decimal(total),
});

describe('isBudgetExhausted', () => {
  it('is never exhausted without budgets', () => {
    expect(isBudgetExhausted(budget(null, null), 1e9, 1e9)).toBe(false);
  });

  it('trips when monthly spend reaches the monthly budget', () => {
    expect(isBudgetExhausted(budget(500, null), 499.99, 10_000)).toBe(false);
    expect(isBudgetExhausted(budget(500, null), 500, 500)).toBe(true);
  });

  it('trips when lifetime spend reaches the total budget even if this month is low', () => {
    expect(isBudgetExhausted(budget(500, 2000), 10, 2000)).toBe(true);
  });

  it('treats a zero budget as unset rather than instantly exhausted', () => {
    expect(isBudgetExhausted(budget(0, 0), 5, 5)).toBe(false);
  });
});

describe('startOfLocalMonth', () => {
  it('uses the organization timezone for the month boundary', () => {
    // 31 Oct 2026 20:00 UTC is already 1 Nov 01:30 in Kolkata.
    const now = new Date(Date.UTC(2026, 9, 31, 20, 0));
    expect(startOfLocalMonth(now, 'Asia/Kolkata').toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(startOfLocalMonth(now, 'UTC').toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(startOfLocalMonth(now, 'America/Los_Angeles').toISOString()).toBe('2026-10-01T07:00:00.000Z');
  });
});
