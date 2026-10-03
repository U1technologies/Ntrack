import { Router, type Request, type Response } from 'express';
import { created, ok } from '../../lib/response';
import { orgAuth, param, requestMeta } from '../../lib/request';
import { parse } from '../../lib/validate';
import { orgRoute } from '../../middleware/auth';
import type { AppDeps } from '../../types';
import { BulkLinksBody, CreateLinkBody, ListLinksQuery, TemplateBody, UpdateLinkBody } from './links.schemas';
import { LinksService } from './links.service';

export const createLinksRouter = (deps: AppDeps) => {
  const router = Router();
  const service = new LinksService(deps);

  router.get('/templates', ...orgRoute('links.view'), async (req: Request, res: Response) => ok(res, await service.listTemplates(orgAuth(req))));
  router.post('/templates', ...orgRoute('links.manage'), async (req: Request, res: Response) =>
    created(res, await service.saveTemplate(orgAuth(req), parse(TemplateBody, req.body)), 'Template saved')
  );
  router.delete('/templates/:id', ...orgRoute('links.manage'), async (req: Request, res: Response) => {
    await service.removeTemplate(orgAuth(req), param(req, 'id'));
    return ok(res, null, 'Template deleted');
  });
  router.post('/preview', ...orgRoute('links.manage'), async (req: Request, res: Response) => ok(res, await service.preview(orgAuth(req), parse(CreateLinkBody, req.body))));
  router.post('/bulk', ...orgRoute('links.manage'), async (req: Request, res: Response) =>
    created(res, await service.bulkCreate(orgAuth(req), parse(BulkLinksBody, req.body), requestMeta(req)), 'Links generated')
  );
  router.get('/export.csv', ...orgRoute(['links.view', 'reports.export']), async (req: Request, res: Response) => {
    const csv = await service.exportCsv(orgAuth(req), parse(ListLinksQuery.partial(), req.query));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ntrack-links-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  });
  router.get('/', ...orgRoute('links.view'), async (req: Request, res: Response) => ok(res, await service.list(orgAuth(req), parse(ListLinksQuery, req.query))));
  router.post('/', ...orgRoute('links.manage'), async (req: Request, res: Response) =>
    created(res, await service.create(orgAuth(req), parse(CreateLinkBody, req.body), requestMeta(req)), 'Tracking link generated')
  );
  router.patch('/:id', ...orgRoute('links.manage'), async (req: Request, res: Response) =>
    ok(res, await service.update(orgAuth(req), param(req, 'id'), parse(UpdateLinkBody, req.body), requestMeta(req)), 'Link updated')
  );
  return router;
};
