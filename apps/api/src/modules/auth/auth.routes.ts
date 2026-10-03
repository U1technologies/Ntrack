import { Router, type Request, type Response } from 'express';
import { ok } from '../../lib/response';
import { requestMeta } from '../../lib/request';
import { parse } from '../../lib/validate';
import { requireAuth } from '../../middleware/auth';
import { accountTokenLimit, loginRateLimit, passwordResetRequestLimit } from '../../middleware/rate-limit';
import { AcceptInvitationBody, InvitationTokenBody, InvitationsService } from '../users/invitations.service';
import { ForgotPasswordBody, PasswordResetService, ResetPasswordWithTokenBody } from './password-reset.service';
import type { AppDeps } from '../../types';
import { createAuthController } from './auth.controller';

export const createAuthRouter = (deps: AppDeps) => {
  const router = Router();
  const controller = createAuthController(deps);

  router.get('/csrf', controller.csrf);
  router.post('/login', loginRateLimit(deps), controller.login);
  router.post('/mfa/verify', loginRateLimit(deps), requireAuth({ allowMfaPending: true }), controller.verifyMfa);
  router.post('/logout', controller.logout);
  router.get('/me', requireAuth({ allowMfaPending: true }), controller.me);
  router.post('/switch-organization', requireAuth(), controller.switchOrganization);
  router.post('/mfa/setup', requireAuth({ allowMfaSetup: true }), controller.startMfaSetup);
  router.post('/mfa/enable', requireAuth({ allowMfaSetup: true }), controller.enableMfa);
  router.post('/mfa/disable', requireAuth(), controller.disableMfa);
  router.post('/password', requireAuth({ allowMfaSetup: true }), controller.changePassword);

  // Public account flows. Tokens travel in the body so they never appear in access logs.
  const passwordReset = new PasswordResetService(deps);
  const invitations = new InvitationsService(deps);
  const SAME_ANSWER = 'If an account exists for this email, we sent a link to reset the password. It expires in 30 minutes.';
  router.post('/password/forgot', passwordResetRequestLimit(deps), async (req: Request, res: Response) => {
    await passwordReset.request(parse(ForgotPasswordBody, req.body).email, requestMeta(req));
    return ok(res, null, SAME_ANSWER);
  });
  router.post('/password/reset', accountTokenLimit(deps), async (req: Request, res: Response) =>
    ok(res, await passwordReset.reset(parse(ResetPasswordWithTokenBody, req.body), requestMeta(req)), 'Password updated. Sign in with your new password.')
  );
  router.post('/invitations/lookup', accountTokenLimit(deps), async (req: Request, res: Response) =>
    ok(res, await invitations.lookup(parse(InvitationTokenBody, req.body).token))
  );
  router.post('/invitations/accept', accountTokenLimit(deps), async (req: Request, res: Response) =>
    ok(res, await invitations.accept(parse(AcceptInvitationBody, req.body), requestMeta(req)), 'Invitation accepted. Sign in to continue.')
  );
  return router;
};
