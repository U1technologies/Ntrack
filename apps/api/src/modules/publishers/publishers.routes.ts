import { Router, type Request, type Response } from 'express';
import { created, ok } from '../../lib/response';
import { orgAuth, param, requestMeta } from '../../lib/request';
import { parse } from '../../lib/validate';
import { orgRoute } from '../../middleware/auth';
import type { AppDeps } from '../../types';
import { ListPublishersQuery, PublisherBody, PublisherDecisionBody, UpdatePublisherBody } from './publishers.schemas';
import { PublishersService } from './publishers.service';

export const createPublishersRouter = (deps: AppDeps) => {
  const router = Router();
  const service = new PublishersService(deps);
  router.get('/', ...orgRoute('publishers.view'), async (req: Request, res: Response) =>
    ok(res, await service.list(orgAuth(req), parse(ListPublishersQuery, req.query)))
  );
  router.get('/:id', ...orgRoute('publishers.view'), async (req: Request, res: Response) => ok(res, await service.get(orgAuth(req), param(req, 'id'))));
  router.post('/', ...orgRoute('publishers.manage'), async (req: Request, res: Response) =>
    created(res, await service.create(orgAuth(req), parse(PublisherBody, req.body), requestMeta(req)), 'Publisher created')
  );
  router.patch('/:id', ...orgRoute('publishers.manage'), async (req: Request, res: Response) =>
    ok(res, await service.update(orgAuth(req), param(req, 'id'), parse(UpdatePublisherBody, req.body), requestMeta(req)), 'Publisher updated')
  );
  router.post('/:id/decision', ...orgRoute('publishers.approve'), async (req: Request, res: Response) =>
    ok(res, await service.decide(orgAuth(req), param(req, 'id'), parse(PublisherDecisionBody, req.body), requestMeta(req)), 'Publisher status updated')
  );
  router.delete('/:id', ...orgRoute('publishers.manage'), async (req: Request, res: Response) => {
    await service.remove(orgAuth(req), param(req, 'id'), requestMeta(req));
    return ok(res, null, 'Publisher deleted');
  });
  return router;
};
