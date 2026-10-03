import { Router, type Request, type Response } from 'express';
import { created, ok } from '../../lib/response';
import { orgAuth, param, requestMeta } from '../../lib/request';
import { parse } from '../../lib/validate';
import { orgRoute, requireAuth } from '../../middleware/auth';
import type { AppDeps } from '../../types';
import { CreateRoleBody, UpdateRoleBody } from './roles.schemas';
import { RolesService } from './roles.service';

export const createRolesRouter = (deps: AppDeps) => {
  const router = Router();
  const service = new RolesService(deps);

  router.get('/permissions', requireAuth(), (_req: Request, res: Response) => ok(res, service.catalogue()));
  router.get('/', ...orgRoute(['roles.view', 'users.manage']), async (req: Request, res: Response) => ok(res, await service.list(orgAuth(req))));
  router.post('/', ...orgRoute('roles.manage'), async (req: Request, res: Response) =>
    created(res, await service.create(orgAuth(req), parse(CreateRoleBody, req.body), requestMeta(req)), 'Role created')
  );
  router.patch('/:id', ...orgRoute('roles.manage'), async (req: Request, res: Response) =>
    ok(res, await service.update(orgAuth(req), param(req, 'id'), parse(UpdateRoleBody, req.body), requestMeta(req)), 'Role updated')
  );
  router.delete('/:id', ...orgRoute('roles.manage'), async (req: Request, res: Response) => {
    await service.remove(orgAuth(req), param(req, 'id'), requestMeta(req));
    return ok(res, null, 'Role deleted');
  });
  return router;
};
