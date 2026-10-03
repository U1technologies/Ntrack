import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { hasAnyPermission, type PermissionKey } from '@ntrack/shared';
import { sha256 } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { buildAuthContext } from '../services/auth-context';
import type { AppDeps } from '../types';

export const SESSION_COOKIE = 'ntrack_session';

/** Loads the session (if any) onto req.auth. Never rejects; use requireAuth for that. */
export const loadSession =
  ({ prisma }: AppDeps): RequestHandler =>
  async (req, _res, next) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || token.length < 20) return next();
    const session = await prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { select: { id: true, email: true, name: true, isPlatformAdmin: true, mfaEnabled: true, status: true } } },
    });
    if (!session || session.expiresAt < new Date() || session.user.status !== 'active') return next();
    req.auth = await buildAuthContext(prisma, session);
    // Touch at most every 5 minutes to avoid a write per request.
    if (Date.now() - session.lastSeenAt.getTime() > 5 * 60_000) {
      await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
    }
    next();
  };

interface RequireAuthOptions {
  /** Allow sessions that passed the password step but not yet MFA (MFA verify/logout routes). */
  allowMfaPending?: boolean;
  /** Allow users who must set up MFA before anything else (MFA setup routes). */
  allowMfaSetup?: boolean;
}

export const requireAuth =
  (options: RequireAuthOptions = {}): RequestHandler =>
  (req, _res, next) => {
    const auth = req.auth;
    if (!auth) throw AppError.unauthorized();
    if (!auth.mfaVerified && !options.allowMfaPending) throw new AppError(401, 'Two-factor verification required', 'mfa_required');
    if (auth.mfaSetupRequired && !options.allowMfaSetup && !options.allowMfaPending) {
      throw new AppError(403, 'Your organization requires two-factor authentication. Set it up to continue.', 'mfa_setup_required');
    }
    next();
  };

export const requireOrganization: RequestHandler = (req, _res, next) => {
  if (!req.auth?.organizationId) throw new AppError(403, 'Select an organization to continue', 'organization_required');
  next();
};

/** Any-of permission check. Data-level scope is enforced separately inside services. */
export const requirePermission =
  (required: PermissionKey | PermissionKey[]): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth || !hasAnyPermission(req.auth.permissions, required)) throw AppError.forbidden();
    next();
  };

export const requirePlatformAdmin: RequestHandler = (req, _res, next) => {
  if (!req.auth?.user.isPlatformAdmin) throw AppError.forbidden();
  next();
};

/** Standard chain for organization data routes. */
export const orgRoute = (permission: PermissionKey | PermissionKey[]) => [requireAuth(), requireOrganization, requirePermission(permission)];
