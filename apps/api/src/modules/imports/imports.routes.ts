import { Router, type Request, type Response } from 'express';
import { created, ok } from '../../lib/response';
import { orgAuth, param, requestMeta } from '../../lib/request';
import { parse, uuid } from '../../lib/validate';
import { orgRoute } from '../../middleware/auth';
import type { AppDeps } from '../../types';
import { CreateImportBody, ImportRowsQuery, ImportsService, RowDecisionBody } from './imports.service';

/** Migration imports (settings.manage, organization-wide roles only). */
export const createImportsRouter = (deps: AppDeps) => {
  const router = Router();
  const service = new ImportsService(deps);
  const id = (req: Request, name = 'id') => parse(uuid, param(req, name));

  router.get('/templates', ...orgRoute('settings.manage'), (_req: Request, res: Response) => ok(res, service.templates()));
  router.get('/', ...orgRoute('settings.manage'), async (req: Request, res: Response) => ok(res, await service.list(orgAuth(req))));
  router.post('/', ...orgRoute('settings.manage'), async (req: Request, res: Response) =>
    created(res, await service.create(orgAuth(req), parse(CreateImportBody, req.body), requestMeta(req)), 'File checked. Review the rows before importing.')
  );
  router.get('/:id', ...orgRoute('settings.manage'), async (req: Request, res: Response) => ok(res, await service.get(orgAuth(req), id(req), parse(ImportRowsQuery, req.query))));
  router.patch('/:id/rows/:rowId', ...orgRoute('settings.manage'), async (req: Request, res: Response) =>
    ok(res, await service.decide(orgAuth(req), id(req), id(req, 'rowId'), parse(RowDecisionBody, req.body).decision))
  );
  router.post('/:id/commit', ...orgRoute('settings.manage'), async (req: Request, res: Response) => ok(res, await service.commit(orgAuth(req), id(req), requestMeta(req)), 'Import started'));
  router.post('/:id/undo', ...orgRoute('settings.manage'), async (req: Request, res: Response) => ok(res, await service.undo(orgAuth(req), id(req), requestMeta(req)), 'Import undone'));
  return router;
};
