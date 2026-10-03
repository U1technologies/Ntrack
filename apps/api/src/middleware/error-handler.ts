import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@ntrack/db';
import { AppError } from '../lib/errors';
import type { Logger } from '../lib/logger';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint not found', data: null });
};

/** Global error handler: operational errors keep their status; everything else is logged and hidden. */
export const errorHandler =
  (logger: Logger): ErrorRequestHandler =>
  (error, req, res, _next) => {
    if (error instanceof AppError) {
      return res.status(error.status).json({ success: false, message: error.message, code: error.code, data: error.details ?? null });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') return res.status(409).json({ success: false, message: 'A record with these details already exists', code: 'conflict', data: null });
      if (error.code === 'P2025') return res.status(404).json({ success: false, message: 'Record not found', code: 'not_found', data: null });
      if (error.code === 'P2003') return res.status(409).json({ success: false, message: 'This record is still referenced by other records', code: 'conflict', data: null });
    }
    if ((error as { type?: string }).type === 'entity.parse.failed') {
      return res.status(400).json({ success: false, message: 'Malformed JSON body', code: 'bad_request', data: null });
    }
    logger.error({ err: error, path: req.path, method: req.method }, 'unhandled API error');
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.', code: 'internal', data: null });
  };
