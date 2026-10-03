import { Router, type Request, type Response } from 'express';
import { created, ok } from '../../lib/response';
import { orgAuth, param, requestMeta } from '../../lib/request';
import { parse, patchSchema } from '../../lib/validate';
import { orgRoute } from '../../middleware/auth';
import type { AppDeps } from '../../types';
import { CostBody, FeedBody, ImportBody, ManualRecordBody, PartnerBody, SearchReportQuery, SearchService } from './search.service';

export const createSearchRouter = (deps: AppDeps) => {
  const router = Router();
  const service = new SearchService(deps);
  router.get('/partners', ...orgRoute('search.view'), async (req: Request, res: Response) => ok(res, await service.listPartners(orgAuth(req))));
  router.post('/partners', ...orgRoute('search.manage'), async (req: Request, res: Response) =>
    created(res, await service.createPartner(orgAuth(req), parse(PartnerBody, req.body), requestMeta(req)), 'Partner created')
  );
  router.patch('/partners/:id', ...orgRoute('search.manage'), async (req: Request, res: Response) =>
    ok(res, await service.updatePartner(orgAuth(req), param(req, 'id'), parse(patchSchema(PartnerBody), req.body), requestMeta(req)), 'Partner updated')
  );
  router.post('/partners/:id/feeds', ...orgRoute('search.manage'), async (req: Request, res: Response) =>
    created(res, await service.addFeed(orgAuth(req), param(req, 'id'), parse(FeedBody, req.body), requestMeta(req)), 'Feed added')
  );
  router.patch('/feeds/:feedId', ...orgRoute('search.manage'), async (req: Request, res: Response) =>
    ok(res, await service.updateFeed(orgAuth(req), param(req, 'feedId'), parse(patchSchema(FeedBody), req.body), requestMeta(req)), 'Feed updated')
  );
  router.post('/partners/:id/import', ...orgRoute('search.manage'), async (req: Request, res: Response) =>
    ok(res, await service.importReport(orgAuth(req), param(req, 'id'), parse(ImportBody, req.body), requestMeta(req)), 'Report imported')
  );
  router.post('/records', ...orgRoute('search.manage'), async (req: Request, res: Response) =>
    created(res, await service.addRecord(orgAuth(req), parse(ManualRecordBody, req.body), requestMeta(req)), 'Revenue saved')
  );
  router.get('/costs', ...orgRoute('search.view'), async (req: Request, res: Response) => ok(res, await service.listCosts(orgAuth(req))));
  router.post('/costs', ...orgRoute('search.manage'), async (req: Request, res: Response) => created(res, await service.addCost(orgAuth(req), parse(CostBody, req.body), requestMeta(req)), 'Cost saved'));
  router.delete('/costs/:id', ...orgRoute('search.manage'), async (req: Request, res: Response) => {
    await service.removeCost(orgAuth(req), param(req, 'id'), requestMeta(req));
    return ok(res, null, 'Cost deleted');
  });
  router.get('/report', ...orgRoute('search.view'), async (req: Request, res: Response) => ok(res, await service.report(orgAuth(req), parse(SearchReportQuery, req.query))));
  return router;
};
