import type { z } from 'zod';
import type { Prisma, Publisher } from '@ntrack/db';
import { generatePublicId } from '@ntrack/shared';
import { AppError } from '../../lib/errors';
import { paginated } from '../../lib/response';
import { publisherWhere } from '../../services/access-scope';
import { writeAudit } from '../../services/audit';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';
import type { ListPublishersQuery, PaymentDetails, PublisherBody, PublisherDecisionBody, TaxInfo, UpdatePublisherBody } from './publishers.schemas';

type TaxInfoValue = z.infer<typeof TaxInfo>;
type PaymentDetailsValue = z.infer<typeof PaymentDetails>;

export class PublishersService {
  constructor(private readonly deps: AppDeps) {}

  /** Strips encrypted blobs; decrypted details are only returned when `withSensitive` is set. */
  private present(publisher: Publisher, withSensitive: boolean) {
    const { taxInfoEncrypted, paymentDetailsEncrypted, ...rest } = publisher;
    return {
      ...rest,
      hasTaxInfo: Boolean(taxInfoEncrypted),
      hasPaymentDetails: Boolean(paymentDetailsEncrypted),
      ...(withSensitive
        ? {
            taxInfo: this.deps.secretBox.decryptJson<TaxInfoValue>(taxInfoEncrypted),
            paymentDetails: this.deps.secretBox.decryptJson<PaymentDetailsValue>(paymentDetailsEncrypted),
          }
        : {}),
    };
  }

  private canSeeSensitive(auth: OrgAuthContext, publisherId: string) {
    return auth.permissions.has('finance.view') || auth.permissions.has('publishers.manage') || auth.scope.publisherIds.includes(publisherId);
  }

  async list(auth: OrgAuthContext, query: z.infer<typeof ListPublishersQuery>) {
    const where: Prisma.PublisherWhereInput = {
      organizationId: auth.organizationId,
      ...publisherWhere(auth.scope),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { companyName: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
              { publicId: query.search },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.deps.prisma.publisher.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { _count: { select: { campaignPublishers: true, trackingLinks: true } } },
      }),
      this.deps.prisma.publisher.count({ where }),
    ]);
    return paginated(
      items.map(({ _count, ...p }) => ({ ...this.present(p, false), campaignCount: _count.campaignPublishers, linkCount: _count.trackingLinks })),
      total,
      query.page,
      query.pageSize
    );
  }

  private async find(auth: OrgAuthContext, id: string) {
    const publisher = await this.deps.prisma.publisher.findFirst({ where: { id, organizationId: auth.organizationId, ...publisherWhere(auth.scope) } });
    if (!publisher) throw AppError.notFound('Publisher');
    return publisher;
  }

  async get(auth: OrgAuthContext, id: string) {
    const publisher = await this.find(auth, id);
    const applications = await this.deps.prisma.campaignPublisher.findMany({
      where: { publisherId: id },
      include: { campaign: { select: { id: true, name: true, publicId: true, status: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { ...this.present(publisher, this.canSeeSensitive(auth, id)), applications };
  }

  private encryptSensitive(input: { taxInfo?: TaxInfoValue | null; paymentDetails?: PaymentDetailsValue | null }) {
    const data: { taxInfoEncrypted?: string | null; paymentDetailsEncrypted?: string | null } = {};
    if (input.taxInfo !== undefined) data.taxInfoEncrypted = input.taxInfo ? this.deps.secretBox.encryptJson(input.taxInfo) : null;
    if (input.paymentDetails !== undefined) data.paymentDetailsEncrypted = input.paymentDetails ? this.deps.secretBox.encryptJson(input.paymentDetails) : null;
    return data;
  }

  async create(auth: OrgAuthContext, input: z.infer<typeof PublisherBody>, meta: RequestMeta) {
    const { taxInfo, paymentDetails, ...rest } = input;
    const publisher = await this.deps.prisma.publisher.create({
      data: { ...rest, ...this.encryptSensitive({ taxInfo, paymentDetails }), publicId: generatePublicId('pub'), organizationId: auth.organizationId },
    });
    await writeAudit(this.deps.prisma, auth, meta, { action: 'publisher.created', entityType: 'publisher', entityId: publisher.id, summary: publisher.companyName, after: publisher });
    return this.present(publisher, false);
  }

  async update(auth: OrgAuthContext, id: string, input: z.infer<typeof UpdatePublisherBody>, meta: RequestMeta) {
    const before = await this.find(auth, id);
    const { taxInfo, paymentDetails, ...rest } = input;
    const after = await this.deps.prisma.publisher.update({ where: { id }, data: { ...rest, ...this.encryptSensitive({ taxInfo, paymentDetails }) } });
    await writeAudit(this.deps.prisma, auth, meta, { action: 'publisher.updated', entityType: 'publisher', entityId: id, summary: after.companyName, before, after });
    if (input.status && input.status !== before.status) await this.deps.publisher.publishLinksWhere({ publisherId: id });
    return this.present(after, false);
  }

  async decide(auth: OrgAuthContext, id: string, input: z.infer<typeof PublisherDecisionBody>, meta: RequestMeta) {
    const before = await this.find(auth, id);
    const after = await this.deps.prisma.publisher.update({ where: { id }, data: { status: input.status } });
    await writeAudit(this.deps.prisma, auth, meta, {
      action: `publisher.${input.status === 'active' ? 'approved' : input.status}`,
      entityType: 'publisher',
      entityId: id,
      summary: input.note || after.companyName,
      before: { status: before.status },
      after: { status: after.status },
    });
    // Publisher status gates every one of their links on the tracker.
    await this.deps.publisher.publishLinksWhere({ publisherId: id });
    return this.present(after, false);
  }

  async remove(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    const publisher = await this.find(auth, id);
    const links = await this.deps.prisma.trackingLink.findMany({ where: { publisherId: id }, select: { slug: true } });
    if (links.length > 0) throw AppError.conflict('This publisher has tracking links. Suspend the publisher instead to keep reporting intact.');
    await this.deps.prisma.publisher.delete({ where: { id } });
    await writeAudit(this.deps.prisma, auth, meta, { action: 'publisher.deleted', entityType: 'publisher', entityId: id, summary: publisher.companyName, before: publisher });
  }
}
