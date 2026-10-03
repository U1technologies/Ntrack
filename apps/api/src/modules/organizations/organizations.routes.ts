import { Router } from 'express';
import { orgRoute, requireAuth, requirePlatformAdmin } from '../../middleware/auth';
import type { AppDeps } from '../../types';
import { createOrganizationsController } from './organizations.controller';

export const createOrganizationsRouter = (deps: AppDeps) => {
  const router = Router();
  const controller = createOrganizationsController(deps);
  router.get('/current', ...orgRoute('settings.view'), controller.current);
  router.patch('/current/settings', ...orgRoute('settings.manage'), controller.updateSettings);
  router.get('/', requireAuth(), requirePlatformAdmin, controller.list);
  router.post('/', requireAuth(), requirePlatformAdmin, controller.create);
  router.patch('/:id', requireAuth(), requirePlatformAdmin, controller.update);
  return router;
};
