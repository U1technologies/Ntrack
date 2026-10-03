import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { TRAFFIC_TYPES } from '@ntrack/shared';
import { AppError } from '../../lib/errors';
import { created, ok } from '../../lib/response';
import { orgAuth, param, requestMeta } from '../../lib/request';
import { parse, patchSchema } from '../../lib/validate';
import { orgRoute } from '../../middleware/auth';
import { writeAudit } from '../../services/audit';
import type { AppDeps } from '../../types';

const TrafficSourceBody = z.object({
  name: z.string().trim().min(2).max(80),
  type: z.enum(TRAFFIC_TYPES),
  description: z.string().trim().max(300).default(''),
});

export const createTrafficSourcesRouter = ({ prisma }: AppDeps) => {
  const router = Router();
  router.get('/', ...orgRoute(['campaigns.view', 'publishers.view']), async (req: Request, res: Response) =>
    ok(res, await prisma.trafficSource.findMany({ where: { organizationId: orgAuth(req).organizationId }, orderBy: { name: 'asc' } }))
  );
  router.post('/', ...orgRoute('campaigns.manage'), async (req: Request, res: Response) => {
    const auth = orgAuth(req);
    const source = await prisma.trafficSource.create({ data: { ...parse(TrafficSourceBody, req.body), organizationId: auth.organizationId } });
    await writeAudit(prisma, auth, requestMeta(req), { action: 'traffic_source.created', entityType: 'traffic_source', entityId: source.id, after: source });
    return created(res, source, 'Traffic source created');
  });
  router.patch('/:id', ...orgRoute('campaigns.manage'), async (req: Request, res: Response) => {
    const auth = orgAuth(req);
    const before = await prisma.trafficSource.findFirst({ where: { id: param(req, 'id'), organizationId: auth.organizationId } });
    if (!before) throw AppError.notFound('Traffic source');
    const after = await prisma.trafficSource.update({ where: { id: before.id }, data: parse(patchSchema(TrafficSourceBody), req.body) });
    await writeAudit(prisma, auth, requestMeta(req), { action: 'traffic_source.updated', entityType: 'traffic_source', entityId: after.id, before, after });
    return ok(res, after, 'Traffic source updated');
  });
  router.delete('/:id', ...orgRoute('campaigns.manage'), async (req: Request, res: Response) => {
    const auth = orgAuth(req);
    const source = await prisma.trafficSource.findFirst({ where: { id: param(req, 'id'), organizationId: auth.organizationId } });
    if (!source) throw AppError.notFound('Traffic source');
    await prisma.trafficSource.delete({ where: { id: source.id } });
    await writeAudit(prisma, auth, requestMeta(req), { action: 'traffic_source.deleted', entityType: 'traffic_source', entityId: source.id, before: source });
    return ok(res, null, 'Traffic source deleted');
  });
  return router;
};
