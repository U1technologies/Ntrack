import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

const globalForPrisma = globalThis as unknown as { ntrackPrisma?: PrismaClient };

/** One client per process; connection pool size is controlled via DATABASE_URL (?connection_limit=). */
export const prisma: PrismaClient =
  globalForPrisma.ntrackPrisma ??
  new PrismaClient({ log: process.env.PRISMA_LOG_QUERIES === 'true' ? ['query', 'warn', 'error'] : ['warn', 'error'] });

if (process.env.NODE_ENV !== 'production') globalForPrisma.ntrackPrisma = prisma;
