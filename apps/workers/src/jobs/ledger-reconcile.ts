import { syncConversionLedger } from '@ntrack/conversions';
import { prisma } from '@ntrack/db';
import type { Logger } from '../logger';

/**
 * Safety net for the ledger: books any conversion whose booked amounts do not match its state
 * (e.g. approved before the ledger existed, or a crash between commit steps). Idempotent.
 */
export const reconcileLedger = async (log: Logger) => {
  const drifted = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM conversions
    WHERE (status = 'approved' AND (booked_revenue <> revenue OR booked_payout <> payout))
       OR (status <> 'approved' AND (booked_revenue <> 0 OR booked_payout <> 0))
    LIMIT 1000`;
  for (const { id } of drifted) {
    await prisma.$transaction(async (tx) => {
      const conversion = await tx.conversion.findUniqueOrThrow({ where: { id } });
      await syncConversionLedger(tx, conversion, null);
    });
  }
  if (drifted.length) log.info({ fixed: drifted.length }, 'ledger reconciled');
  return { fixed: drifted.length };
};
