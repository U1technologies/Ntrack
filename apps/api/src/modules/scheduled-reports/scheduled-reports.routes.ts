import { Router, type Request, type Response } from 'express';
import { created, ok } from '../../lib/response';
import { orgAuth, param, requestMeta } from '../../lib/request';
import { parse, uuid } from '../../lib/validate';
import { orgRoute } from '../../middleware/auth';
import type { AppDeps } from '../../types';
import { ScheduledReportBody, ScheduledReportPatch, ScheduledReportsService } from './scheduled-reports.service';

export const createScheduledReportsRouter = (deps: AppDeps) => {
  const router = Router();
  const service = new ScheduledReportsService(deps);
  const id = (req: Request) => parse(uuid, param(req, 'id'));

  router.get('/', ...orgRoute('reports.schedule'), async (req: Request, res: Response) => ok(res, await service.list(orgAuth(req))));
  router.post('/', ...orgRoute('reports.schedule'), async (req: Request, res: Response) =>
    created(res, await service.create(orgAuth(req), parse(ScheduledReportBody, req.body), requestMeta(req)), 'Scheduled report created')
  );
  router.patch('/:id', ...orgRoute('reports.schedule'), async (req: Request, res: Response) =>
    ok(res, await service.update(orgAuth(req), id(req), parse(ScheduledReportPatch, req.body), requestMeta(req)), 'Scheduled report updated')
  );
  router.delete('/:id', ...orgRoute('reports.schedule'), async (req: Request, res: Response) =>
    ok(res, await service.remove(orgAuth(req), id(req), requestMeta(req)), 'Scheduled report deleted')
  );
  router.post('/:id/run', ...orgRoute('reports.schedule'), async (req: Request, res: Response) => ok(res, await service.runNow(orgAuth(req), id(req)), 'Report queued'));
  return router;
};
