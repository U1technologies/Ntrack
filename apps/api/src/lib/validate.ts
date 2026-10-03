import { z } from 'zod';
import { AppError } from './errors';

/** Parses request input with a Zod schema, converting failures into a 400 with field details. */
export const parse = <S extends z.ZodType>(schema: S, input: unknown): z.infer<S> => {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    throw AppError.badRequest('Validation failed', { fields });
  }
  return result.data;
};

export const PaginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(200).optional(),
  sort: z.string().max(50).optional(),
  direction: z.enum(['asc', 'desc']).default('desc'),
});
export type PaginationQuery = z.infer<typeof PaginationQuery>;

export const skipTake = (query: Pick<PaginationQuery, 'page' | 'pageSize'>) => ({ skip: (query.page - 1) * query.pageSize, take: query.pageSize });

/** Accepts arrays or comma-separated strings in query strings. */
export const csvArray = <T extends z.ZodType>(item: T) =>
  z.preprocess((value) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value), z.array(item));

export const countryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Use ISO 3166-1 alpha-2 country codes');

export const uuid = z.string().uuid();

/**
 * PATCH schema from a create schema: every field optional and **no defaults**. Zod's `.partial()`
 * keeps `.default()` values, which would silently reset omitted fields on every update.
 */
export const patchSchema = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) =>
  z.object(
    Object.fromEntries(
      Object.entries(schema.shape).map(([key, field]) => {
        const inner = field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : (field as z.ZodType);
        return [key, inner.optional()];
      })
    )
  ) as unknown as z.ZodObject<{ [K in keyof T]: z.ZodOptional<T[K]> }>;
