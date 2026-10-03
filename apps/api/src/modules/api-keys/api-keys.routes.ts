import { Router, type Request, type Response } from 'express';
import { created, ok } from '../../lib/response';
import { orgAuth, param, requestMeta } from '../../lib/request';
import { parse, uuid } from '../../lib/validate';
import { orgRoute } from '../../middleware/auth';
import type { AppDeps } from '../../types';
import { ApiKeysService, ApiLogsQuery, CreateApiKeyBody } from './api-keys.service';

export const createApiKeysRouter = (deps: AppDeps) => {
  const router = Router();
  const service = new ApiKeysService(deps);
  const id = (req: Request) => parse(uuid, param(req, 'id'));

  router.get('/', ...orgRoute(['integrations.view', 'integrations.manage']), async (req: Request, res: Response) => ok(res, await service.list(orgAuth(req))));
  router.get('/grantable-permissions', ...orgRoute('integrations.manage'), (req: Request, res: Response) => ok(res, service.grantable(orgAuth(req))));
  router.get('/logs', ...orgRoute(['integrations.view', 'integrations.manage']), async (req: Request, res: Response) => ok(res, await service.logs(orgAuth(req), parse(ApiLogsQuery, req.query))));
  router.get('/usage', ...orgRoute(['integrations.view', 'integrations.manage']), async (req: Request, res: Response) => ok(res, await service.usage(orgAuth(req))));
  router.post('/', ...orgRoute('integrations.manage'), async (req: Request, res: Response) =>
    created(res, await service.create(orgAuth(req), parse(CreateApiKeyBody, req.body), requestMeta(req)), 'API key created. Copy the secret now; it is shown only once.')
  );
  router.post('/:id/revoke', ...orgRoute('integrations.manage'), async (req: Request, res: Response) => ok(res, await service.revoke(orgAuth(req), id(req), requestMeta(req)), 'API key revoked'));
  router.post('/:id/rotate', ...orgRoute('integrations.manage'), async (req: Request, res: Response) =>
    ok(res, await service.rotate(orgAuth(req), id(req), requestMeta(req)), 'API key rotated. Copy the new secret now; the old one no longer works.')
  );
  return router;
};
