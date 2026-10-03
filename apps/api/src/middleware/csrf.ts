import type { RequestHandler } from 'express';
import { safeEqual } from '../lib/crypto';
import { AppError } from '../lib/errors';
import type { AppDeps } from '../types';

export const CSRF_COOKIE = 'ntrack_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF protection plus an Origin check. The console reads the (non-httpOnly)
 * ntrack_csrf cookie and echoes it in X-CSRF-Token on every state-changing request; a cross-site
 * page can neither read the cookie nor set the header. Applies to login too (login CSRF).
 */
export const csrfProtection =
  ({ config }: AppDeps): RequestHandler =>
  (req, _res, next) => {
    // API key requests carry no cookies, and browsers cannot add the Authorization header
    // cross-site without a CORS grant (none is given), so CSRF does not apply to them.
    if (SAFE_METHODS.has(req.method) || req.auth?.apiKey) return next();
    const origin = req.get('origin');
    if (origin && origin !== config.CONSOLE_ORIGIN) throw new AppError(403, 'Cross-origin request rejected', 'csrf');
    const cookie = req.cookies?.[CSRF_COOKIE];
    const header = req.get(CSRF_HEADER);
    if (typeof cookie !== 'string' || !header || !safeEqual(cookie, header)) throw new AppError(403, 'Invalid or missing CSRF token', 'csrf');
    next();
  };
