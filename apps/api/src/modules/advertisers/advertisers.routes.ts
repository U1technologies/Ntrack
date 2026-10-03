import { Router, type Request, type Response } from 'express';
import { created, ok } from '../../lib/response';
import { orgAuth, param, requestMeta } from '../../lib/request';
import { parse } from '../../lib/validate';
import { orgRoute } from '../../middleware/auth';
import type { AppDeps } from '../../types';
import { AdvertiserBody, ListAdvertisersQuery, UpdateAdvertiserBody } from './advertisers.schemas';
import { AdvertisersService } from './advertisers.service';

export const createAdvertisersRouter = (deps: AppDeps) => {
  const router = Router();
  const service = new AdvertisersService(deps);
  router.get('/', ...orgRoute('advertisers.view'), async (req: Request, res: Response) =>
    ok(res, await service.list(orgAuth(req), parse(ListAdvertisersQuery, req.query)))
  );
  router.get('/:id', ...orgRoute('advertisers.view'), async (req: Request, res: Response) => ok(res, await service.get(orgAuth(req), param(req, 'id'))));
  router.post('/', ...orgRoute('advertisers.manage'), async (req: Request, res: Response) =>
    created(res, await service.create(orgAuth(req), parse(AdvertiserBody, req.body), requestMeta(req)), 'Advertiser created')
  );
  router.patch('/:id', ...orgRoute('advertisers.manage'), async (req: Request, res: Response) =>
    ok(res, await service.update(orgAuth(req), param(req, 'id'), parse(UpdateAdvertiserBody, req.body), requestMeta(req)), 'Advertiser updated')
  );
  router.get('/:id/tracking-setup', ...orgRoute(['advertisers.manage', 'postbacks.view']), async (req: Request, res: Response) =>
    ok(res, await service.trackingSetup(orgAuth(req), param(req, 'id')))
  );
  router.post('/:id/postback-token', ...orgRoute(['advertisers.manage', 'postbacks.manage']), async (req: Request, res: Response) =>
    ok(res, await service.rotatePostbackToken(orgAuth(req), param(req, 'id'), requestMeta(req)), 'New postback token issued')
  );
  router.delete('/:id', ...orgRoute('advertisers.manage'), async (req: Request, res: Response) => {
    await service.remove(orgAuth(req), param(req, 'id'), requestMeta(req));
    return ok(res, null, 'Advertiser deleted');
  });
  return router;
};
