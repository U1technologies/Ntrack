import { Router, type Request, type Response } from 'express';
import { created, ok } from '../../lib/response';
import { orgAuth, param, requestMeta } from '../../lib/request';
import { parse } from '../../lib/validate';
import { orgRoute } from '../../middleware/auth';
import type { AppDeps } from '../../types';
import { AdjustBody, BulkStatusBody, CreateConversionBody, ListConversionsQuery, RecalculateBody, StatusChangeBody } from './conversions.schemas';
import { ConversionsService } from './conversions.service';

export const createConversionsRouter = (deps: AppDeps) => {
  const router = Router();
  const service = new ConversionsService(deps);

  router.get('/', ...orgRoute('conversions.view'), async (req: Request, res: Response) => ok(res, await service.list(orgAuth(req), parse(ListConversionsQuery, req.query))));
  router.get('/export.csv', ...orgRoute(['reports.export', 'conversions.view']), async (req: Request, res: Response) => {
    const csv = await service.exportCsv(orgAuth(req), parse(ListConversionsQuery, req.query));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ntrack-conversions-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  });
  router.post('/', ...orgRoute('conversions.manage'), async (req: Request, res: Response) =>
    created(res, await service.create(orgAuth(req), parse(CreateConversionBody, req.body), requestMeta(req)), 'Conversion recorded')
  );
  router.post('/bulk-status', ...orgRoute('conversions.approve'), async (req: Request, res: Response) =>
    ok(res, await service.bulkStatus(orgAuth(req), parse(BulkStatusBody, req.body), requestMeta(req)), 'Conversions updated')
  );
  router.get('/:id', ...orgRoute('conversions.view'), async (req: Request, res: Response) => ok(res, await service.get(orgAuth(req), param(req, 'id'))));
  router.post('/:id/status', ...orgRoute('conversions.approve'), async (req: Request, res: Response) =>
    ok(res, await service.changeStatus(orgAuth(req), param(req, 'id'), parse(StatusChangeBody, req.body), requestMeta(req)), 'Status updated')
  );
  router.post('/:id/adjust', ...orgRoute('conversions.manage'), async (req: Request, res: Response) =>
    ok(res, await service.adjust(orgAuth(req), param(req, 'id'), parse(AdjustBody, req.body), requestMeta(req)), 'Conversion adjusted')
  );
  router.post('/:id/recalculate-attribution', ...orgRoute('attribution.manage'), async (req: Request, res: Response) =>
    ok(res, await service.recalculate(orgAuth(req), param(req, 'id'), parse(RecalculateBody, req.body).model, requestMeta(req)), 'Attribution recalculated')
  );
  return router;
};
