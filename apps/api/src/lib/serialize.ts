import { Prisma } from '@ntrack/db';

/** JSON-safe output: Decimals become strings (exact money), BigInts become strings, Dates ISO. */
export const serialize = <T>(value: T): T =>
  JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (item instanceof Prisma.Decimal) return item.toString();
      if (typeof item === 'bigint') return item.toString();
      return item;
    })
  ) as T;
