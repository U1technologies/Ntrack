import { z } from 'zod';
import type { DataRequest, Prisma } from '@ntrack/db';
import { AppError } from '../../lib/errors';
import { paginated } from '../../lib/response';
import { writeAudit } from '../../services/audit';
import type { FileStore } from '../../services/file-store';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';
import { ErasureExecutor } from './erasure';
import { ExportBuilder } from './export-builder';

export const CreateDataRequestBody = z.object({
  type: z.enum(['export', 'erasure']),
  subjectType: z.enum(['user', 'publisher', 'advertiser', 'organization']),
  subjectId: z.string().uuid(),
  reason: z.string().trim().min(3, 'Record why (e.g. the request reference)').max(1000),
});

export const ListDataRequestsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['pending_review', 'approved', 'processing', 'completed', 'rejected', 'failed']).optional(),
  type: z.enum(['export', 'erasure']).optional(),
});

export const ReviewBody = z.object({ note: z.string().trim().max(1000).default('') });
export const SelfErasureBody = z.object({ reason: z.string().trim().max(1000).default('') });

/** Queues an approved request for the job runner. */
export type DataRequestEnqueue = (requestId: string) => Promise<void>;

export const enqueueDataRequest =
  (deps: AppDeps): DataRequestEnqueue =>
  async (requestId) => {
    await deps.dataRequestQueue.add('process', { requestId }, { jobId: `process-${requestId}-${Date.now()}`, attempts: 1, removeOnComplete: 200, removeOnFail: 500 });
  };

const OPEN_STATUSES: DataRequest['status'][] = ['pending_review', 'approved', 'processing'];

/**
 * Privacy requests. Exports run as soon as they are created by someone allowed to see the data;
 * erasures always wait for a second person with privacy.manage to approve them.
 */
export class PrivacyService {
  constructor(
    private readonly deps: AppDeps,
    private readonly files: FileStore,
    private readonly enqueue: DataRequestEnqueue
  ) {}

  private get prisma() {
    return this.deps.prisma;
  }

  /** Confirms the subject exists in this organization and the actor may act on it; returns a display label. */
  private async resolveSubject(auth: OrgAuthContext, subjectType: DataRequest['subjectType'], subjectId: string): Promise<string> {
    const inScope = (ids: string[]) => !auth.scope.restricted || ids.includes(subjectId);
    switch (subjectType) {
      case 'user': {
        const member = await this.prisma.organizationMember.findUnique({
          where: { organizationId_userId: { organizationId: auth.organizationId, userId: subjectId } },
          include: { user: { select: { email: true, isPlatformAdmin: true } } },
        });
        if (!member) throw AppError.badRequest('This person is not a member of the organization');
        if (auth.scope.restricted) throw AppError.forbidden('Requests about users need an organization-wide role');
        return member.user.email;
      }
      case 'publisher': {
        const publisher = await this.prisma.publisher.findFirst({ where: { id: subjectId, organizationId: auth.organizationId } });
        if (!publisher || !inScope(auth.scope.publisherIds)) throw AppError.badRequest('Unknown publisher');
        return publisher.companyName;
      }
      case 'advertiser': {
        const advertiser = await this.prisma.advertiser.findFirst({ where: { id: subjectId, organizationId: auth.organizationId } });
        if (!advertiser || !inScope(auth.scope.advertiserIds)) throw AppError.badRequest('Unknown advertiser');
        return advertiser.companyName;
      }
      default: {
        if (subjectId !== auth.organizationId) throw AppError.badRequest('Organization requests apply to the current organization');
        if (auth.scope.restricted) throw AppError.forbidden('Organization exports need an organization-wide role');
        const organization = await this.prisma.organization.findUniqueOrThrow({ where: { id: auth.organizationId }, select: { name: true } });
        return organization.name;
      }
    }
  }

  private async assertNoOpenRequest(organizationId: string, input: Pick<DataRequest, 'type' | 'subjectType' | 'subjectId'>) {
    const open = await this.prisma.dataRequest.findFirst({ where: { organizationId, type: input.type, subjectType: input.subjectType, subjectId: input.subjectId, status: { in: OPEN_STATUSES } } });
    if (open) throw AppError.conflict('There is already an open request of this type for this subject');
  }

  async create(auth: OrgAuthContext, input: z.infer<typeof CreateDataRequestBody>, meta: RequestMeta) {
    if (input.type === 'erasure' && input.subjectType === 'organization') throw AppError.badRequest('Erasing a whole organization is not supported yet');
    if (input.type === 'erasure' && input.subjectType === 'user' && input.subjectId === auth.user.id) {
      throw AppError.badRequest('To erase your own account, use "Request account deletion" in your security settings');
    }
    if (input.type === 'erasure' && input.subjectType === 'user') {
      const memberships = await this.prisma.organizationMember.count({ where: { userId: input.subjectId } });
      if (memberships > 1 && !auth.user.isPlatformAdmin) throw AppError.forbidden('This person belongs to other organizations; a platform administrator must handle the erasure');
    }
    const label = await this.resolveSubject(auth, input.subjectType, input.subjectId);
    await this.assertNoOpenRequest(auth.organizationId, input);
    const request = await this.prisma.dataRequest.create({
      data: {
        organizationId: auth.organizationId,
        type: input.type,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        subjectLabel: label,
        reason: input.reason,
        requestedById: auth.user.id,
        // Exports by someone who can already see the data run straight away; erasures need review.
        status: input.type === 'export' ? 'approved' : 'pending_review',
      },
    });
    await writeAudit(this.prisma, auth, meta, { action: `privacy.${input.type}_requested`, entityType: 'data_request', entityId: request.id, summary: `${input.subjectType} ${label}` });
    if (request.status === 'approved') await this.enqueue(request.id);
    else this.notifyReviewers(auth, request);
    return request;
  }

  private notifyReviewers(auth: OrgAuthContext, request: DataRequest) {
    this.deps.notifier.emit({
      organizationId: request.organizationId,
      type: 'privacy.request_submitted',
      title: `Erasure request needs review: ${request.subjectType} ${request.subjectLabel}`,
      body: request.reason,
      link: '/ntrack/settings/privacy',
      actorUserId: auth.user.id,
    });
  }

  async list(auth: OrgAuthContext, query: z.infer<typeof ListDataRequestsQuery>) {
    // Self-service exports contain a person's data across organizations; only they can see those.
    const where: Prisma.DataRequestWhereInput = {
      organizationId: auth.organizationId,
      NOT: { AND: [{ selfService: true }, { type: 'export' }] },
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.dataRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.dataRequest.count({ where }),
    ]);
    const people = await this.prisma.user.findMany({ where: { id: { in: items.flatMap((i) => [i.requestedById, ...(i.reviewedById ? [i.reviewedById] : [])]) } }, select: { id: true, name: true } });
    const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
    return paginated(
      items.map(({ fileKey: _hidden, ...item }) => ({ ...item, requestedByName: nameOf(item.requestedById), reviewedByName: nameOf(item.reviewedById), downloadable: Boolean(item.fileExpiresAt && item.fileExpiresAt > new Date()) })),
      total,
      query.page,
      query.pageSize
    );
  }

  private async findForReview(auth: OrgAuthContext, id: string) {
    const request = await this.prisma.dataRequest.findFirst({ where: { id, organizationId: auth.organizationId } });
    if (!request) throw AppError.notFound('Request');
    if (request.status !== 'pending_review') throw AppError.conflict('Only requests waiting for review can be approved or rejected');
    return request;
  }

  async approve(auth: OrgAuthContext, id: string, note: string, meta: RequestMeta) {
    const request = await this.findForReview(auth, id);
    // Four-eyes rule: the person who asked cannot approve their own erasure request.
    if (request.requestedById === auth.user.id && !auth.user.isPlatformAdmin) throw AppError.forbidden('A different person must approve this request');
    await this.resolveSubject(auth, request.subjectType, request.subjectId);
    if (request.type === 'erasure' && request.subjectType === 'user' && !auth.user.isPlatformAdmin) {
      const memberships = await this.prisma.organizationMember.count({ where: { userId: request.subjectId } });
      if (memberships > 1) throw AppError.forbidden('This person belongs to other organizations; a platform administrator must approve the erasure');
    }
    const updated = await this.prisma.dataRequest.update({ where: { id }, data: { status: 'approved', reviewedById: auth.user.id, reviewedAt: new Date(), reviewNote: note } });
    await writeAudit(this.prisma, auth, meta, { action: 'privacy.request_approved', entityType: 'data_request', entityId: id, summary: note });
    await this.enqueue(id);
    return updated;
  }

  async reject(auth: OrgAuthContext, id: string, note: string, meta: RequestMeta) {
    await this.findForReview(auth, id);
    if (note.length < 3) throw AppError.badRequest('Explain why the request is rejected');
    const updated = await this.prisma.dataRequest.update({ where: { id }, data: { status: 'rejected', reviewedById: auth.user.id, reviewedAt: new Date(), reviewNote: note } });
    await writeAudit(this.prisma, auth, meta, { action: 'privacy.request_rejected', entityType: 'data_request', entityId: id, summary: note });
    return updated;
  }

  /** Opens an export archive for download, enforcing who may read it. */
  async download(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    const request = await this.prisma.dataRequest.findFirst({ where: { id, organizationId: auth.organizationId, type: 'export' } });
    if (!request) throw AppError.notFound('Export');
    const allowed = request.selfService ? request.requestedById === auth.user.id : auth.permissions.has('privacy.view') || request.requestedById === auth.user.id;
    if (!allowed) throw AppError.notFound('Export');
    if (request.status !== 'completed' || !request.fileKey) throw AppError.conflict('This export is not ready yet');
    if (!request.fileExpiresAt || request.fileExpiresAt < new Date()) throw new AppError(410, 'This export has expired. Create a new one.', 'expired');
    await writeAudit(this.prisma, auth, meta, { action: 'privacy.export_downloaded', entityType: 'data_request', entityId: id });
    return { stream: this.files.reader(request.fileKey), filename: `ntrack-export-${request.subjectType}-${request.createdAt.toISOString().slice(0, 10)}.zip` };
  }

  // ─── Self service ─────────────────────────────────────────────────────────

  async myRequests(auth: OrgAuthContext) {
    const items = await this.prisma.dataRequest.findMany({ where: { organizationId: auth.organizationId, requestedById: auth.user.id, selfService: true }, orderBy: { createdAt: 'desc' }, take: 20 });
    return items.map(({ fileKey: _hidden, ...item }) => ({ ...item, downloadable: Boolean(item.fileExpiresAt && item.fileExpiresAt > new Date()) }));
  }

  async exportMine(auth: OrgAuthContext, meta: RequestMeta) {
    const subject = { type: 'export' as const, subjectType: 'user' as const, subjectId: auth.user.id };
    await this.assertNoOpenRequest(auth.organizationId, subject);
    const request = await this.prisma.dataRequest.create({
      data: { organizationId: auth.organizationId, ...subject, subjectLabel: auth.user.email, selfService: true, reason: 'Self-service export', requestedById: auth.user.id, status: 'approved' },
    });
    await writeAudit(this.prisma, auth, meta, { action: 'privacy.export_requested', entityType: 'data_request', entityId: request.id, summary: 'self-service' });
    await this.enqueue(request.id);
    return request;
  }

  async requestMyErasure(auth: OrgAuthContext, reason: string, meta: RequestMeta) {
    if (auth.user.isPlatformAdmin) throw AppError.forbidden('Platform administrator accounts are removed by another platform administrator');
    const subject = { type: 'erasure' as const, subjectType: 'user' as const, subjectId: auth.user.id };
    await this.assertNoOpenRequest(auth.organizationId, subject);
    const request = await this.prisma.dataRequest.create({
      data: { organizationId: auth.organizationId, ...subject, subjectLabel: auth.user.email, selfService: true, reason: reason || 'Self-service account deletion request', requestedById: auth.user.id },
    });
    await writeAudit(this.prisma, auth, meta, { action: 'privacy.erasure_requested', entityType: 'data_request', entityId: request.id, summary: 'self-service' });
    this.notifyReviewers(auth, request);
    return request;
  }

  // ─── Processing (job runner) ──────────────────────────────────────────────

  /** Runs one approved request. Safe to call twice: only an approved request is claimed. */
  async process(id: string): Promise<void> {
    const claimed = await this.prisma.dataRequest.updateMany({ where: { id, status: 'approved' }, data: { status: 'processing' } });
    if (claimed.count !== 1) return;
    const request = await this.prisma.dataRequest.findUniqueOrThrow({ where: { id } });
    try {
      if (request.type === 'export') {
        const result = await new ExportBuilder(this.deps, this.files).build(request);
        await this.prisma.dataRequest.update({
          where: { id },
          data: {
            status: 'completed',
            completedAt: new Date(),
            fileKey: result.fileKey,
            fileSize: result.size,
            fileExpiresAt: new Date(Date.now() + this.deps.config.DATA_EXPORT_TTL_DAYS * 86_400_000),
            summary: { files: result.files },
          },
        });
      } else {
        const summary = await new ErasureExecutor(this.deps).run(request);
        await this.prisma.dataRequest.update({ where: { id }, data: { status: 'completed', completedAt: new Date(), summary: JSON.parse(JSON.stringify(summary)) as Prisma.InputJsonValue } });
      }
      await writeAudit(this.prisma, null, { ip: '', userAgent: 'ntrack-privacy-job' }, { action: `privacy.${request.type}_completed`, entityType: 'data_request', entityId: id, organizationId: request.organizationId });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Unknown error';
      await this.prisma.dataRequest.update({ where: { id }, data: { status: 'failed', error: message } });
      this.deps.logger.error({ err: error, requestId: id }, 'privacy request failed');
    }
  }

  /** Removes expired export archives (generated copies of personal data) and re-queues stuck requests. */
  async sweep(): Promise<{ expired: number; requeued: number }> {
    const expired = await this.prisma.dataRequest.findMany({ where: { fileKey: { not: null }, fileExpiresAt: { lt: new Date() } }, select: { id: true, fileKey: true } });
    for (const item of expired) {
      await this.files.remove(item.fileKey!);
      await this.prisma.dataRequest.update({ where: { id: item.id }, data: { fileKey: null } });
    }
    const stuck = await this.prisma.dataRequest.findMany({ where: { status: 'approved', updatedAt: { lt: new Date(Date.now() - 10 * 60_000) } }, select: { id: true } });
    for (const item of stuck) await this.enqueue(item.id);
    return { expired: expired.length, requeued: stuck.length };
  }
}
