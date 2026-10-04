import type { Prisma, PrismaClient } from '@ntrack/db';

export type SerialEntity = 'advertiser' | 'publisher' | 'campaign';

/**
 * Next serial number (1, 2, 3...) for an entity within an organization. One atomic statement, so
 * concurrent creates never get the same number; inside a transaction a rollback returns the number.
 */
export const nextSerialNumber = async (db: PrismaClient | Prisma.TransactionClient, organizationId: string, entity: SerialEntity): Promise<number> => {
  const rows = await db.$queryRaw<Array<{ value: number }>>`
    INSERT INTO "organization_counters" ("organization_id", "entity", "value")
    VALUES (${organizationId}::uuid, ${entity}, 1)
    ON CONFLICT ("organization_id", "entity") DO UPDATE SET "value" = "organization_counters"."value" + 1
    RETURNING "value"`;
  const value = rows[0]?.value;
  if (!value) throw new Error(`Could not allocate a ${entity} number`);
  return Number(value);
};
