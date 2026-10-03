import type { Prisma, PrismaClient } from '@ntrack/db';
import { zonedMidnight } from '@ntrack/shared';

/**
 * Budget usage = revenue (advertiser spend) of pending + approved conversions. Pending counts so a
 * burst of unreviewed conversions cannot overspend; rejected and reversed conversions free the
 * budget again on the next refresh. Monthly budgets reset on the 1st in the organization timezone.
 */

export interface BudgetedCampaign {
  id: string;
  monthlyBudget: Prisma.Decimal | null;
  totalBudget: Prisma.Decimal | null;
  timezone: string;
}

export interface BudgetUsage {
  monthSpend: number;
  totalSpend: number;
  exhausted: boolean;
}

const COUNTED_STATUSES = ['pending', 'approved'] as const;

export const startOfLocalMonth = (now: Date, timeZone: string): Date => {
  const [year, month] = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).format(now).split('-');
  return zonedMidnight(`${year}-${month}-01`, timeZone);
};

export const isBudgetExhausted = (campaign: Pick<BudgetedCampaign, 'monthlyBudget' | 'totalBudget'>, monthSpend: number, totalSpend: number): boolean => {
  const monthly = campaign.monthlyBudget === null ? null : Number(campaign.monthlyBudget);
  const total = campaign.totalBudget === null ? null : Number(campaign.totalBudget);
  return (monthly !== null && monthly > 0 && monthSpend >= monthly) || (total !== null && total > 0 && totalSpend >= total);
};

export const computeBudgetUsage = async (
  db: PrismaClient,
  campaigns: BudgetedCampaign[],
  now: Date = new Date()
): Promise<Map<string, BudgetUsage>> => {
  const budgeted = campaigns.filter((c) => c.monthlyBudget !== null || c.totalBudget !== null);
  const usage = new Map<string, BudgetUsage>();
  if (budgeted.length === 0) return usage;

  const ids = budgeted.map((c) => c.id);
  const totals = await db.conversion.groupBy({
    by: ['campaignId'],
    where: { campaignId: { in: ids }, status: { in: [...COUNTED_STATUSES] } },
    _sum: { revenue: true },
  });
  const totalByCampaign = new Map(totals.map((row) => [row.campaignId, Number(row._sum.revenue ?? 0)]));

  // Month boundaries depend on the organization timezone, so query once per timezone.
  const byTimezone = new Map<string, string[]>();
  for (const campaign of budgeted.filter((c) => c.monthlyBudget !== null)) {
    byTimezone.set(campaign.timezone, [...(byTimezone.get(campaign.timezone) ?? []), campaign.id]);
  }
  const monthByCampaign = new Map<string, number>();
  for (const [timezone, campaignIds] of byTimezone) {
    const rows = await db.conversion.groupBy({
      by: ['campaignId'],
      where: { campaignId: { in: campaignIds }, status: { in: [...COUNTED_STATUSES] }, convertedAt: { gte: startOfLocalMonth(now, timezone) } },
      _sum: { revenue: true },
    });
    rows.forEach((row) => monthByCampaign.set(row.campaignId, Number(row._sum.revenue ?? 0)));
  }

  for (const campaign of budgeted) {
    const monthSpend = monthByCampaign.get(campaign.id) ?? 0;
    const totalSpend = totalByCampaign.get(campaign.id) ?? 0;
    usage.set(campaign.id, { monthSpend, totalSpend, exhausted: isBudgetExhausted(campaign, monthSpend, totalSpend) });
  }
  return usage;
};
