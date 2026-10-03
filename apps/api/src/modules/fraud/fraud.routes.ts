import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Prisma } from '@ntrack/db';
import { FRAUD_RULE_DESCRIPTIONS, FRAUD_RULE_TYPES } from '@ntrack/shared';
import { AppError } from '../../lib/errors';
import { created, ok, paginated } from '../../lib/response';
import { orgAuth, param, requestMeta } from '../../lib/request';
import { serialize } from '../../lib/serialize';
import { parse, patchSchema } from '../../lib/validate';
import { orgRoute } from '../../middleware/auth';
import { isPublisherPortal } from '../../services/access-scope';
import { writeAudit } from '../../services/audit';
import type { AppDeps, OrgAuthContext } from '../../types';

const RuleBody = z.object({
  name: z.string().trim().min(3).max(120),
  type: z.enum(FRAUD_RULE_TYPES),
  threshold: z.coerce.number().positive().max(1_000_000),
  windowMinutes: z.coerce.number().int().min(0).max(43_200).default(60),
  minVolume: z.coerce.number().int().min(0).max(10_000_000).default(0),
  severity: z.enum(['low', 'medium', 'high']).default('medium'),
  action: z.enum(['flag', 'hold']).default('flag'),
  active: z.boolean().default(true),
});

const ListEventsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  status: z.enum(['open', 'confirmed', 'dismissed', 'appealed']).optional(),
  severity: z.enum(['low', 'medium', 'high']).optional(),
  type: z.enum(FRAUD_RULE_TYPES).optional(),
  publisherId: z.string().uuid().optional(),
});

const ReviewBody = z.object({
  status: z.enum(['confirmed', 'dismissed']),
  note: z.string().trim().min(3, 'Explain the decision').max(1000),
  /** Optional enforcement when confirming. Each is explicit; nothing happens automatically. */
  actions: z.array(z.enum(['reject_conversion', 'block_on_campaign', 'suspend_publisher'])).default([]),
});

const AppealBody = z.object({ note: z.string().trim().min(10, 'Explain why this is legitimate traffic').max(2000) });

export const createFraudRouter = (deps: AppDeps) => {
  const router = Router();
  const { prisma } = deps;

  const eventScope = (auth: OrgAuthContext): Prisma.FraudEventWhereInput =>
    auth.scope.restricted ? { AND: [{ publisherId: { in: auth.scope.publisherIds.length ? auth.scope.publisherIds : ['00000000-0000-0000-0000-000000000000'] } }] } : {};

  router.get('/rule-types', ...orgRoute('fraud.view'), (_req: Request, res: Response) => ok(res, FRAUD_RULE_DESCRIPTIONS));

  router.get('/rules', ...orgRoute('fraud.manage'), async (req: Request, res: Response) =>
    ok(res, serialize(await prisma.fraudRule.findMany({ where: { organizationId: orgAuth(req).organizationId }, orderBy: { createdAt: 'asc' }, include: { _count: { select: { events: true } } } })))
  );
  router.post('/rules', ...orgRoute('fraud.manage'), async (req: Request, res: Response) => {
    const auth = orgAuth(req);
    const rule = await prisma.fraudRule.create({ data: { ...parse(RuleBody, req.body), organizationId: auth.organizationId } });
    await writeAudit(prisma, auth, requestMeta(req), { action: 'fraud_rule.created', entityType: 'fraud_rule', entityId: rule.id, after: rule });
    return created(res, serialize(rule), 'Rule created');
  });
  router.patch('/rules/:id', ...orgRoute('fraud.manage'), async (req: Request, res: Response) => {
    const auth = orgAuth(req);
    const before = await prisma.fraudRule.findFirst({ where: { id: param(req, 'id'), organizationId: auth.organizationId } });
    if (!before) throw AppError.notFound('Rule');
    const after = await prisma.fraudRule.update({ where: { id: before.id }, data: parse(patchSchema(RuleBody), req.body) });
    await writeAudit(prisma, auth, requestMeta(req), { action: 'fraud_rule.updated', entityType: 'fraud_rule', entityId: after.id, before, after });
    return ok(res, serialize(after), 'Rule updated');
  });
  router.delete('/rules/:id', ...orgRoute('fraud.manage'), async (req: Request, res: Response) => {
    const auth = orgAuth(req);
    const rule = await prisma.fraudRule.findFirst({ where: { id: param(req, 'id'), organizationId: auth.organizationId } });
    if (!rule) throw AppError.notFound('Rule');
    await prisma.fraudRule.delete({ where: { id: rule.id } });
    await writeAudit(prisma, auth, requestMeta(req), { action: 'fraud_rule.deleted', entityType: 'fraud_rule', entityId: rule.id, before: rule });
    return ok(res, null, 'Rule deleted');
  });

  router.get('/events', ...orgRoute('fraud.view'), async (req: Request, res: Response) => {
    const auth = orgAuth(req);
    const query = parse(ListEventsQuery, req.query);
    const where: Prisma.FraudEventWhereInput = {
      organizationId: auth.organizationId,
      ...eventScope(auth),
      ...(query.status ? { status: query.status } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.publisherId ? { publisherId: query.publisherId } : {}),
    };
    const [items, total, counts] = await Promise.all([
      prisma.fraudEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      prisma.fraudEvent.count({ where }),
      prisma.fraudEvent.groupBy({ by: ['status'], where: { organizationId: auth.organizationId, ...eventScope(auth) }, _count: { _all: true } }),
    ]);
    const [publishers, campaigns] = await Promise.all([
      prisma.publisher.findMany({ where: { id: { in: items.flatMap((e) => (e.publisherId ? [e.publisherId] : [])) } }, select: { id: true, companyName: true } }),
      prisma.campaign.findMany({ where: { id: { in: items.flatMap((e) => (e.campaignId ? [e.campaignId] : [])) } }, select: { id: true, name: true } }),
    ]);
    const enriched = items.map((e) => ({
      ...serialize(e),
      publisher: publishers.find((p) => p.id === e.publisherId) ?? null,
      campaign: campaigns.find((c) => c.id === e.campaignId) ?? null,
      // Publishers see the explanation, not internal rule thresholds or reviewer notes.
      ...(isPublisherPortal(auth.scope) ? { details: undefined, reviewNote: undefined, ruleId: undefined } : {}),
    }));
    return ok(res, { ...paginated(enriched, total, query.page, query.pageSize), counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) });
  });

  router.post('/events/:id/review', ...orgRoute('fraud.manage'), async (req: Request, res: Response) => {
    const auth = orgAuth(req);
    const body = parse(ReviewBody, req.body);
    const event = await prisma.fraudEvent.findFirst({ where: { id: param(req, 'id'), organizationId: auth.organizationId } });
    if (!event) throw AppError.notFound('Fraud event');
    if (body.status === 'dismissed' && body.actions.length) throw AppError.badRequest('Enforcement actions only apply when confirming');

    const applied: string[] = [];
    if (body.status === 'confirmed') {
      if (body.actions.includes('reject_conversion')) {
        if (!event.conversionId) throw AppError.badRequest('This event is not tied to a conversion');
        await deps.conversions.changeStatus(auth.organizationId, event.conversionId, 'rejected', auth.user.id, `Fraud confirmed: ${body.note}`).catch((error: Error) => {
          throw AppError.conflict(error.message);
        });
        applied.push('conversion rejected');
      }
      if (body.actions.includes('block_on_campaign')) {
        if (!event.publisherId || !event.campaignId) throw AppError.badRequest('This event is not tied to a publisher and campaign');
        await prisma.campaignPublisher.upsert({
          where: { campaignId_publisherId: { campaignId: event.campaignId, publisherId: event.publisherId } },
          create: { organizationId: auth.organizationId, campaignId: event.campaignId, publisherId: event.publisherId, status: 'blocked', decisionNote: `Fraud: ${body.note}`, decidedAt: new Date(), decidedById: auth.user.id },
          update: { status: 'blocked', decisionNote: `Fraud: ${body.note}`, decidedAt: new Date(), decidedById: auth.user.id },
        });
        await deps.publisher.publishLinksWhere({ campaignId: event.campaignId, publisherId: event.publisherId });
        applied.push('publisher blocked on campaign');
      }
      if (body.actions.includes('suspend_publisher')) {
        if (!event.publisherId) throw AppError.badRequest('This event is not tied to a publisher');
        await prisma.publisher.update({ where: { id: event.publisherId }, data: { status: 'suspended' } });
        await deps.publisher.publishLinksWhere({ publisherId: event.publisherId });
        applied.push('publisher suspended');
      }
    }
    const updated = await prisma.fraudEvent.update({
      where: { id: event.id },
      data: { status: body.status, reviewNote: [body.note, applied.length ? `Actions: ${applied.join(', ')}` : ''].filter(Boolean).join('. '), reviewedById: auth.user.id, reviewedAt: new Date() },
    });
    await writeAudit(prisma, auth, requestMeta(req), { action: `fraud_event.${body.status}`, entityType: 'fraud_event', entityId: event.id, summary: body.note, after: { applied } });
    return ok(res, serialize(updated), `Event ${body.status}`);
  });

  /** Publishers can appeal events about their own traffic; reviewers see the appeal in the queue. */
  router.post('/events/:id/appeal', ...orgRoute('fraud.view'), async (req: Request, res: Response) => {
    const auth = orgAuth(req);
    const body = parse(AppealBody, req.body);
    const event = await prisma.fraudEvent.findFirst({ where: { id: param(req, 'id'), organizationId: auth.organizationId, ...eventScope(auth) } });
    if (!event) throw AppError.notFound('Fraud event');
    if (!isPublisherPortal(auth.scope)) throw AppError.forbidden('Only the affected publisher can appeal');
    if (!['open', 'confirmed'].includes(event.status)) throw AppError.conflict('This event cannot be appealed');
    const updated = await prisma.fraudEvent.update({ where: { id: event.id }, data: { status: 'appealed', appealNote: body.note } });
    await writeAudit(prisma, auth, requestMeta(req), { action: 'fraud_event.appealed', entityType: 'fraud_event', entityId: event.id, summary: body.note });
    return ok(res, { ...serialize(updated), details: undefined, reviewNote: undefined }, 'Appeal submitted');
  });

  return router;
};
