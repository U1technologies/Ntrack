import type { Response } from 'express';

/** Standard response envelope: { success, message, data }. */
export const ok = <T>(res: Response, data: T, message = 'OK', status = 200) => res.status(status).json({ success: true, message, data });

export const created = <T>(res: Response, data: T, message = 'Created') => ok(res, data, message, 201);

export interface Paginated<T> {
  items: T[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export const paginated = <T>(items: T[], total: number, page: number, pageSize: number): Paginated<T> => ({
  items,
  pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
});
