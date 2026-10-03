import { Router, type Request, type Response } from 'express';
import { created, ok } from '../../lib/response';
import { orgAuth, param, requestMeta } from '../../lib/request';
import { parse } from '../../lib/validate';
import { orgRoute } from '../../middleware/auth';
import { toolRateLimit } from '../../middleware/rate-limit';
import type { AppDeps } from '../../types';
import { CreateDomainBody, UpdateDomainBody } from './domains.schemas';
import { DomainsService } from './domains.service';

export const createDomainsRouter = (deps: AppDeps) => {
  const router = Router();
  const service = new DomainsService(deps);
  // Publishers and advertisers need the domain list to generate links; details stay admin-only.
  router.get('/', ...orgRoute(['domains.view', 'links.manage']), async (req: Request, res: Response) => ok(res, await service.list(orgAuth(req))));
  router.get('/:id', ...orgRoute('domains.view'), async (req: Request, res: Response) => ok(res, await service.get(orgAuth(req), param(req, 'id'))));
  router.post('/', ...orgRoute('domains.manage'), async (req: Request, res: Response) =>
    created(res, await service.create(orgAuth(req), parse(CreateDomainBody, req.body), requestMeta(req)), 'Domain added. Add the DNS records, then verify.')
  );
  router.patch('/:id', ...orgRoute('domains.manage'), async (req: Request, res: Response) =>
    ok(res, await service.update(orgAuth(req), param(req, 'id'), parse(UpdateDomainBody, req.body), requestMeta(req)), 'Domain updated')
  );
  router.post('/:id/verify', toolRateLimit(deps), ...orgRoute('domains.manage'), async (req: Request, res: Response) => {
    const result = await service.verify(orgAuth(req), param(req, 'id'), requestMeta(req));
    return ok(res, result, result.verified ? 'Domain verified' : 'DNS records not found yet');
  });
  router.post('/:id/check', toolRateLimit(deps), ...orgRoute('domains.manage'), async (req: Request, res: Response) =>
    ok(res, await service.checkNow(orgAuth(req), param(req, 'id')), 'Health check complete')
  );
  router.delete('/:id', ...orgRoute('domains.manage'), async (req: Request, res: Response) => {
    await service.remove(orgAuth(req), param(req, 'id'), requestMeta(req));
    return ok(res, null, 'Domain deleted');
  });
  return router;
};
