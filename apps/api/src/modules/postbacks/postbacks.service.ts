import type { z } from 'zod';
import { POSTBACK_JOB_OPTIONS, deliveryEventId } from '@ntrack/conversions';
import type { Postback, Prisma } from '@ntrack/db';
import { MACROS, generatePublicId, renderTemplate, validateOutboundUrl } from '@ntrack/shared';
import { AppError } from '../../lib/errors';
import { paginated } from '../../lib/response';
import { isPublisherPortal, postbackWhere } from '../../services/access-scope';
import { writeAudit } from '../../services/audit';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';
import type { ListDeliveriesQuery, PostbackBody, UpdatePostbackBody } from './postbacks.schemas';

const present = ({ authTokenEncrypted, hmacSecretEncrypted, ...postback }: Postback & Record<string, unknown>) => ({
  ...postback,
  hasAuthToken: Boolean(authTokenEncrypted),
  hasHmacSecret: Boolean(hmacSecretEncrypted),
});

const SAMPLE = { click_id: 'X', campaign_id: 'cmp', publisher_id: 'pub', conversion_id: 'cnv', payout: '1', revenue: '1', currency: 'USD', event: 'sale', status: 'approved' };

export class PostbacksService {
  constructor(private readonly deps: AppDeps) {}

  /** SSRF guard at save time (delivery re-checks the resolved IP on every attempt). */
  private assertDestination(urlTemplate: string) {
    const check = validateOutboundUrl(renderTemplate(urlTemplate, SAMPLE, { context: 'postback', encoding: 'query' }), { requireHttps: false });
    if (!check.ok && !(this.deps.config.ALLOW_PRIVATE_OUTBOUND && check.reason === 'private_address')) {
      throw AppError.badRequest(`Postback URL rejected: ${check.reason.replace(/_/g, ' ')}`);
    }
  }

  macroDocs() {
    return MACROS.filter((m) => m.contexts.includes('postback'));
  }

  async list(auth: OrgAuthContext) {
    const postbacks = await this.deps.prisma.postback.findMany({
      where: { organizationId: auth.organizationId, ...postbackWhere(auth.scope) },
      include: { publisher: { select: { id: true, companyName: true } }, campaign: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return postbacks.map(present);
  }

  private async find(auth: OrgAuthContext, id: string) {
    const postback = await this.deps.prisma.postback.findFirst({ where: { id, organizationId: auth.organizationId, ...postbackWhere(auth.scope) } });
    if (!postback) throw AppError.notFound('Postback');
    return postback;
  }

  /** Publisher users can only create postbacks for themselves; network roles may target any publisher. */
  private async resolveOwner(auth: OrgAuthContext, input: { publisherId?: string | null; campaignId?: string | null }) {
    const publisherId = isPublisherPortal(auth.scope) ? auth.scope.publisherIds[0] : (input.publisherId ?? null);
    if (isPublisherPortal(auth.scope) && !publisherId) throw AppError.forbidden();
    if (publisherId && !(await this.deps.prisma.publisher.findFirst({ where: { id: publisherId, organizationId: auth.organizationId } }))) throw AppError.badRequest('Unknown publisher');
    if (input.campaignId && !(await this.deps.prisma.campaign.findFirst({ where: { id: input.campaignId, organizationId: auth.organizationId } }))) throw AppError.badRequest('Unknown campaign');
    if (!publisherId && auth.scope.restricted) throw AppError.forbidden('Organization-wide postbacks require organization access');
    return publisherId;
  }

  private secrets(input: { authToken?: string | null; hmacSecret?: string | null }) {
    const data: { authTokenEncrypted?: string | null; hmacSecretEncrypted?: string | null } = {};
    if (input.authToken !== undefined) data.authTokenEncrypted = input.authToken ? this.deps.secretBox.encrypt(input.authToken) : null;
    if (input.hmacSecret !== undefined) data.hmacSecretEncrypted = input.hmacSecret ? this.deps.secretBox.encrypt(input.hmacSecret) : null;
    return data;
  }

  async create(auth: OrgAuthContext, input: z.infer<typeof PostbackBody>, meta: RequestMeta) {
    this.assertDestination(input.urlTemplate);
    const publisherId = await this.resolveOwner(auth, input);
    const { authToken, hmacSecret, bodyTemplate, ...rest } = input;
    const postback = await this.deps.prisma.postback.create({
      data: {
        ...rest,
        publisherId,
        campaignId: input.campaignId ?? null,
        bodyTemplate: (bodyTemplate ?? undefined) as Prisma.InputJsonValue | undefined,
        ...this.secrets({ authToken, hmacSecret }),
        publicId: generatePublicId('pb'),
        organizationId: auth.organizationId,
      },
    });
    await writeAudit(this.deps.prisma, auth, meta, { action: 'postback.created', entityType: 'postback', entityId: postback.id, summary: postback.name, after: present(postback) });
    return present(postback);
  }

  async update(auth: OrgAuthContext, id: string, input: z.infer<typeof UpdatePostbackBody>, meta: RequestMeta) {
    const before = await this.find(auth, id);
    if (input.urlTemplate) this.assertDestination(input.urlTemplate);
    const publisherId = input.publisherId !== undefined || input.campaignId !== undefined ? await this.resolveOwner(auth, { publisherId: input.publisherId ?? before.publisherId, campaignId: input.campaignId ?? before.campaignId }) : before.publisherId;
    const { authToken, hmacSecret, bodyTemplate, ...rest } = input;
    const after = await this.deps.prisma.postback.update({
      where: { id },
      data: {
        ...rest,
        publisherId,
        bodyTemplate: bodyTemplate === undefined ? undefined : ((bodyTemplate ?? null) as Prisma.InputJsonValue),
        ...this.secrets({ authToken, hmacSecret }),
      },
    });
    await writeAudit(this.deps.prisma, auth, meta, { action: 'postback.updated', entityType: 'postback', entityId: id, before: present(before), after: present(after) });
    return present(after);
  }

  async remove(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    const postback = await this.find(auth, id);
    await this.deps.prisma.postback.delete({ where: { id } });
    await writeAudit(this.deps.prisma, auth, meta, { action: 'postback.deleted', entityType: 'postback', entityId: id, summary: postback.name });
  }

  /** Sends sample values so the receiver can verify parsing, signature and auth. */
  async test(auth: OrgAuthContext, id: string) {
    const postback = await this.find(auth, id);
    const delivery = await this.deps.prisma.webhookDelivery.create({
      data: {
        organizationId: auth.organizationId,
        postbackId: postback.id,
        eventId: `evt_test_${Date.now()}`,
        event: postback.events[0] ?? 'conversion.created',
        requestMethod: postback.method,
        requestUrl: postback.urlTemplate,
        isTest: true,
      },
    });
    // Tests try once; there is nothing to retry for a sample payload.
    await this.deps.postbackQueue.add('deliver', { deliveryId: delivery.id }, { ...POSTBACK_JOB_OPTIONS, attempts: 1, jobId: delivery.id });
    return delivery;
  }

  async deliveries(auth: OrgAuthContext, query: z.infer<typeof ListDeliveriesQuery>) {
    const where: Prisma.WebhookDeliveryWhereInput = {
      organizationId: auth.organizationId,
      postback: postbackWhere(auth.scope),
      ...(query.postbackId ? { postbackId: query.postbackId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [items, total] = await Promise.all([
      this.deps.prisma.webhookDelivery.findMany({
        where,
        include: { postback: { select: { id: true, name: true } }, conversion: { select: { id: true, publicId: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.deps.prisma.webhookDelivery.count({ where }),
    ]);
    return paginated(items, total, query.page, query.pageSize);
  }

  /** Replays a delivery as a fresh job. The event ID stays the same so receivers can deduplicate. */
  async replay(auth: OrgAuthContext, deliveryId: string, meta: RequestMeta) {
    const delivery = await this.deps.prisma.webhookDelivery.findFirst({ where: { id: deliveryId, organizationId: auth.organizationId, postback: postbackWhere(auth.scope) } });
    if (!delivery) throw AppError.notFound('Delivery');
    if (delivery.isTest) throw AppError.badRequest('Use "Send test" again instead of replaying a test delivery');
    const replay = await this.deps.prisma.webhookDelivery.create({
      data: {
        organizationId: delivery.organizationId,
        postbackId: delivery.postbackId,
        conversionId: delivery.conversionId,
        eventId: delivery.conversionId ? deliveryEventId(delivery.postbackId, delivery.conversionId, delivery.event) : delivery.eventId,
        event: delivery.event,
        requestMethod: delivery.requestMethod,
        requestUrl: delivery.requestUrl,
      },
    });
    await this.deps.postbackQueue.add('deliver', { deliveryId: replay.id }, { ...POSTBACK_JOB_OPTIONS, jobId: replay.id });
    await writeAudit(this.deps.prisma, auth, meta, { action: 'postback.replayed', entityType: 'postback', entityId: delivery.postbackId, summary: deliveryId });
    return replay;
  }
}
