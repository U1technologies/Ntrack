import { Router, type Request, type Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { created, ok } from '../../lib/response';
import { orgAuth, param, requestMeta } from '../../lib/request';
import { parse, uuid } from '../../lib/validate';
import { orgRoute, requireAuth, requireOrganization } from '../../middleware/auth';
import type { AppDeps } from '../../types';
import { CreateDataRequestBody, ListDataRequestsQuery, PrivacyService, ReviewBody, SelfErasureBody, enqueueDataRequest } from './privacy.service';

export const createPrivacyRouter = (deps: AppDeps) => {
  const router = Router();
  const service = new PrivacyService(deps, deps.files, enqueueDataRequest(deps));
  const id = (req: Request) => parse(uuid, param(req, 'id'));
  const own = [requireAuth(), requireOrganization];

  // Self service: any member can export their own data or ask for their account to be erased.
  router.get('/me/requests', ...own, async (req: Request, res: Response) => ok(res, await service.myRequests(orgAuth(req))));
  router.post('/me/export', ...own, async (req: Request, res: Response) => created(res, await service.exportMine(orgAuth(req), requestMeta(req)), 'Your export is being prepared'));
  router.post('/me/erasure', ...own, async (req: Request, res: Response) =>
    created(res, await service.requestMyErasure(orgAuth(req), parse(SelfErasureBody, req.body).reason, requestMeta(req)), 'Your request was sent to your administrators for review')
  );

  router.get('/requests', ...orgRoute('privacy.view'), async (req: Request, res: Response) => ok(res, await service.list(orgAuth(req), parse(ListDataRequestsQuery, req.query))));
  router.post('/requests', ...orgRoute('privacy.manage'), async (req: Request, res: Response) =>
    created(res, await service.create(orgAuth(req), parse(CreateDataRequestBody, req.body), requestMeta(req)), 'Request created')
  );
  router.post('/requests/:id/approve', ...orgRoute('privacy.manage'), async (req: Request, res: Response) =>
    ok(res, await service.approve(orgAuth(req), id(req), parse(ReviewBody, req.body).note, requestMeta(req)), 'Request approved')
  );
  router.post('/requests/:id/reject', ...orgRoute('privacy.manage'), async (req: Request, res: Response) =>
    ok(res, await service.reject(orgAuth(req), id(req), parse(ReviewBody, req.body).note, requestMeta(req)), 'Request rejected')
  );
  // Permission is checked inside: self-service exports are readable only by the person they describe.
  router.get('/requests/:id/download', ...own, async (req: Request, res: Response) => {
    const file = await service.download(orgAuth(req), id(req), requestMeta(req));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    await pipeline(file.stream, res);
  });
  return router;
};
