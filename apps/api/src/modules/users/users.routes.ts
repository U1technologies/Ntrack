import { Router, type Request, type Response } from 'express';
import { created, ok } from '../../lib/response';
import { orgAuth, param, requestMeta } from '../../lib/request';
import { parse } from '../../lib/validate';
import { orgRoute } from '../../middleware/auth';
import type { AppDeps } from '../../types';
import { AssignmentsBody, CreateMemberBody, ListMembersQuery, ResetPasswordBody, UpdateMemberBody } from './users.schemas';
import { UsersService } from './users.service';

export const createUsersRouter = (deps: AppDeps) => {
  const router = Router();
  const service = new UsersService(deps);

  router.get('/', ...orgRoute(['users.view', 'users.manage']), async (req: Request, res: Response) =>
    ok(res, await service.list(orgAuth(req), parse(ListMembersQuery, req.query)))
  );
  router.post('/', ...orgRoute('users.manage'), async (req: Request, res: Response) =>
    created(res, await service.create(orgAuth(req), parse(CreateMemberBody, req.body), requestMeta(req)), 'User added')
  );
  router.patch('/:id', ...orgRoute('users.manage'), async (req: Request, res: Response) =>
    ok(res, await service.update(orgAuth(req), param(req, 'id'), parse(UpdateMemberBody, req.body), requestMeta(req)), 'User updated')
  );
  router.put('/:id/assignments', ...orgRoute('users.manage'), async (req: Request, res: Response) =>
    ok(res, await service.setAssignments(orgAuth(req), param(req, 'id'), parse(AssignmentsBody, req.body), requestMeta(req)), 'Assignments saved')
  );
  router.post('/:id/reset-password', ...orgRoute('users.manage'), async (req: Request, res: Response) => {
    await service.resetPassword(orgAuth(req), param(req, 'id'), parse(ResetPasswordBody, req.body).password, requestMeta(req));
    return ok(res, null, 'Password reset. The user was signed out everywhere.');
  });
  router.delete('/:id', ...orgRoute('users.manage'), async (req: Request, res: Response) => {
    await service.remove(orgAuth(req), param(req, 'id'), requestMeta(req));
    return ok(res, null, 'User removed from organization');
  });
  return router;
};
