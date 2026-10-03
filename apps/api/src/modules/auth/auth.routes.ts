import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { loginRateLimit } from '../../middleware/rate-limit';
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
  return router;
};
