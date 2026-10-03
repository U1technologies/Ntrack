import type { CookieOptions, Request, Response } from 'express';
import { generateSecretToken } from '@ntrack/shared';
import { ok } from '../../lib/response';
import { requestMeta } from '../../lib/request';
import { parse } from '../../lib/validate';
import { CSRF_COOKIE } from '../../middleware/csrf';
import { SESSION_COOKIE } from '../../middleware/auth';
import type { AppDeps } from '../../types';
import { ChangePasswordBody, DisableMfaBody, LoginBody, MfaCodeBody, SwitchOrganizationBody } from './auth.schemas';
import { AuthService } from './auth.service';

export const createAuthController = (deps: AppDeps) => {
  const service = new AuthService(deps);
  const { config } = deps;
  const baseCookie: CookieOptions = { secure: config.COOKIE_SECURE, path: config.COOKIE_PATH };

  const issueCsrf = (res: Response) => {
    const token = generateSecretToken(24);
    res.cookie(CSRF_COOKIE, token, { ...baseCookie, httpOnly: false, sameSite: 'strict', maxAge: config.SESSION_TTL_HOURS * 3_600_000 });
    return token;
  };

  return {
    csrf: (_req: Request, res: Response) => ok(res, { csrfToken: issueCsrf(res) }),

    login: async (req: Request, res: Response) => {
      const body = parse(LoginBody, req.body);
      const result = await service.login(body.email, body.password, requestMeta(req));
      res.cookie(SESSION_COOKIE, result.token, { ...baseCookie, httpOnly: true, sameSite: 'lax', expires: result.expiresAt });
      issueCsrf(res);
      return ok(res, { mfaRequired: result.mfaRequired }, result.mfaRequired ? 'Enter your verification code' : 'Signed in');
    },

    verifyMfa: async (req: Request, res: Response) => {
      const { code } = parse(MfaCodeBody, req.body);
      await service.verifyMfa(req.auth!, code, requestMeta(req));
      return ok(res, null, 'Verified');
    },

    logout: async (req: Request, res: Response) => {
      if (req.auth) await service.logout(req.auth);
      res.clearCookie(SESSION_COOKIE, baseCookie);
      return ok(res, null, 'Signed out');
    },

    me: async (req: Request, res: Response) => ok(res, await service.me(req.auth!)),

    switchOrganization: async (req: Request, res: Response) => {
      const { organizationId } = parse(SwitchOrganizationBody, req.body);
      await service.switchOrganization(req.auth!, organizationId, requestMeta(req));
      return ok(res, null, 'Organization switched');
    },

    startMfaSetup: async (req: Request, res: Response) => ok(res, await service.startMfaSetup(req.auth!)),

    enableMfa: async (req: Request, res: Response) => {
      const { code } = parse(MfaCodeBody, req.body);
      await service.enableMfa(req.auth!, code, requestMeta(req));
      return ok(res, null, 'Two-factor authentication enabled');
    },

    disableMfa: async (req: Request, res: Response) => {
      const body = parse(DisableMfaBody, req.body);
      await service.disableMfa(req.auth!, body.password, body.code, requestMeta(req));
      return ok(res, null, 'Two-factor authentication disabled');
    },

    changePassword: async (req: Request, res: Response) => {
      const body = parse(ChangePasswordBody, req.body);
      await service.changePassword(req.auth!, body.currentPassword, body.newPassword, requestMeta(req));
      return ok(res, null, 'Password changed. Other sessions were signed out.');
    },
  };
};
