import { Router, type Request, type Response } from 'express';
import { created, ok } from '../../lib/response';
import { orgAuth, param, requestMeta } from '../../lib/request';
import { parse } from '../../lib/validate';
import { orgRoute } from '../../middleware/auth';
import { toolRateLimit } from '../../middleware/rate-limit';
import type { AppDeps } from '../../types';
import { ListDeliveriesQuery, PostbackBody, UpdatePostbackBody } from './postbacks.schemas';
import { PostbacksService } from './postbacks.service';

export const createPostbacksRouter = (deps: AppDeps) => {
  const router = Router();
  const service = new PostbacksService(deps);

  router.get('/macros', ...orgRoute('postbacks.view'), (_req: Request, res: Response) => ok(res, service.macroDocs()));
  router.get('/deliveries', ...orgRoute('postbacks.view'), async (req: Request, res: Response) => ok(res, await service.deliveries(orgAuth(req), parse(ListDeliveriesQuery, req.query))));
  router.post('/deliveries/:deliveryId/replay', ...orgRoute('postbacks.manage'), async (req: Request, res: Response) =>
    ok(res, await service.replay(orgAuth(req), param(req, 'deliveryId'), requestMeta(req)), 'Delivery queued again')
  );
  router.get('/', ...orgRoute('postbacks.view'), async (req: Request, res: Response) => ok(res, await service.list(orgAuth(req))));
  router.post('/', ...orgRoute('postbacks.manage'), async (req: Request, res: Response) =>
    created(res, await service.create(orgAuth(req), parse(PostbackBody, req.body), requestMeta(req)), 'Postback created')
  );
  router.patch('/:id', ...orgRoute('postbacks.manage'), async (req: Request, res: Response) =>
    ok(res, await service.update(orgAuth(req), param(req, 'id'), parse(UpdatePostbackBody, req.body), requestMeta(req)), 'Postback updated')
  );
  router.delete('/:id', ...orgRoute('postbacks.manage'), async (req: Request, res: Response) => {
    await service.remove(orgAuth(req), param(req, 'id'), requestMeta(req));
    return ok(res, null, 'Postback deleted');
  });
  router.post('/:id/test', toolRateLimit(deps), ...orgRoute('postbacks.manage'), async (req: Request, res: Response) =>
    ok(res, await service.test(orgAuth(req), param(req, 'id')), 'Test delivery queued')
  );
  return router;
};
