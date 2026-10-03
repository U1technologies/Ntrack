import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Prisma } from '@ntrack/db';
import { ok, paginated } from '../../lib/response';
import { orgAuth } from '../../lib/request';
import { parse } from '../../lib/validate';
import { orgRoute } from '../../middleware/auth';
import type { AppDeps } from '../../types';

const ListAuditQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  entityType: z.string().max(50).optional(),
  entityId: z.string().max(64).optional(),
  action: z.string().max(80).optional(),
  actor: z.string().max(254).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const createAuditRouter = ({ prisma }: AppDeps) => {
  const router = Router();
  router.get('/', ...orgRoute('audit.view'), async (req: Request, res: Response) => {
    const auth = orgAuth(req);
    const query = parse(ListAuditQuery, req.query);
    const where: Prisma.AuditLogWhereInput = {
      organizationId: auth.organizationId,
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.action ? { action: { startsWith: query.action } } : {}),
      ...(query.actor ? { actorEmail: { contains: query.actor, mode: 'insensitive' } } : {}),
      ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lt: new Date(query.to) } : {}) } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      prisma.auditLog.count({ where }),
    ]);
    return ok(res, paginated(items, total, query.page, query.pageSize));
  });
  return router;
};
