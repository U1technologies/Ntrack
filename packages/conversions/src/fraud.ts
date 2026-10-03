import type { PrismaClient } from '@ntrack/db';
import { fraudRiskScore, type ClickContext } from '@ntrack/shared';

export interface IntakeFraudResult {
  hold: boolean;
  reasons: string[];
  events: Array<{ ruleId: string; type: string; severity: string; riskScore: number; reason: string; details: Record<string, unknown> }>;
}

/** Checks that run at conversion time (before the conversion is stored). */
export const evaluateIntakeFraud = async (prisma: PrismaClient, click: ClickContext, receivedAt: number): Promise<IntakeFraudResult> => {
  const rules = await prisma.fraudRule.findMany({ where: { organizationId: click.organizationId, active: true, type: 'fast_conversion' } });
  const result: IntakeFraudResult = { hold: false, reasons: [], events: [] };
  const seconds = Math.max(0, (receivedAt - click.ts) / 1000);
  for (const rule of rules) {
    const threshold = Number(rule.threshold);
    if (seconds >= threshold) continue;
    const reason = `Converted ${seconds.toFixed(1)}s after the click (rule: under ${threshold}s). Real users rarely complete an offer this fast.`;
    result.events.push({ ruleId: rule.id, type: rule.type, severity: rule.severity, riskScore: fraudRiskScore(rule.severity, seconds, threshold, false), reason, details: { seconds, threshold } });
    result.reasons.push(reason);
    if (rule.action === 'hold') result.hold = true;
  }
  return result;
};
