import type { z } from 'zod';
import type { Prisma } from '@ntrack/db';
import { AppError } from '../../lib/errors';
import { paginated } from '../../lib/response';
import { serialize } from '../../lib/serialize';
import { campaignWhere, isAdvertiserPortal, isPublisherPortal } from '../../services/access-scope';
import { writeAudit } from '../../services/audit';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';
import type { ApplicationDecisionBody, AssignPublisherBody, ListApplicationsQuery, PayoutTierBody } from './campaigns.schemas';
import { CampaignsService } from './campaigns.service';

/**
 * Payout tiers and publisher access (applications) for campaigns. Kept apart from the core
 * campaign service because both have their own audit trail and tracker side effects.
 */
export class CampaignPartnersService {
  private readonly campaigns: CampaignsService;

  constructor(private readonly deps: AppDeps) {
    this.campaigns = new CampaignsService(deps);
  }

  private get prisma() {
    return this.deps.prisma;
  }

  // ─── Payout tiers ─────────────────────────────────────────────────────────

  async listPayouts(auth: OrgAuthContext, campaignId: string) {
    await this.campaigns.findAccessible(auth, campaignId);
    const tiers = await this.prisma.campaignPayout.findMany({
      where: { campaignId, ...(isPublisherPortal(auth.scope) ? { OR: [{ publisherId: null }, { publisherId: { in: auth.scope.publisherIds } }], active: true } : {}) },
      include: { publisher: { select: { id: true, companyName: true } }, trafficSource: { select: { id: true, name: true } } },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    return tiers.map((tier) => {
      const output: Record<string, unknown> = serialize(tier);
      if (isPublisherPortal(auth.scope)) delete output.revenue;
      if (isAdvertiserPortal(auth.scope)) delete output.payout;
      return output;
    });
  }

  private async assertTierRefs(auth: OrgAuthContext, input: Partial<z.infer<typeof PayoutTierBody>>) {
    if (input.publisherId && !(await this.prisma.publisher.findFirst({ where: { id: input.publisherId, organizationId: auth.organizationId } }))) {
      throw AppError.badRequest('Unknown publisher');
    }
    if (input.trafficSourceId && !(await this.prisma.trafficSource.findFirst({ where: { id: input.trafficSourceId, organizationId: auth.organizationId } }))) {
      throw AppError.badRequest('Unknown traffic source');
    }
  }

  async addPayout(auth: OrgAuthContext, campaignId: string, input: z.infer<typeof PayoutTierBody>, meta: RequestMeta) {
    await this.campaigns.findAccessible(auth, campaignId);
    await this.assertTierRefs(auth, input);
    return this.prisma.$transaction(async (tx) => {
      const tier = await tx.campaignPayout.create({ data: { ...input, campaignId, organizationId: auth.organizationId } });
      await tx.payoutChangeLog.create({
        data: { organizationId: auth.organizationId, campaignId, campaignPayoutId: tier.id, changedById: auth.user.id, changeType: 'tier_created', after: serialize(tier) as Prisma.InputJsonValue },
      });
      await writeAudit(tx, auth, meta, { action: 'payout_tier.created', entityType: 'campaign', entityId: campaignId, after: tier });
      return serialize(tier);
    });
  }

  async updatePayout(auth: OrgAuthContext, campaignId: string, tierId: string, input: Partial<z.infer<typeof PayoutTierBody>>, meta: RequestMeta) {
    await this.campaigns.findAccessible(auth, campaignId);
    const before = await this.prisma.campaignPayout.findFirst({ where: { id: tierId, campaignId } });
    if (!before) throw AppError.notFound('Payout tier');
    await this.assertTierRefs(auth, input);
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.campaignPayout.update({ where: { id: tierId }, data: input });
      await tx.payoutChangeLog.create({
        data: {
          organizationId: auth.organizationId,
          campaignId,
          campaignPayoutId: tierId,
          changedById: auth.user.id,
          changeType: 'tier_updated',
          before: serialize(before) as Prisma.InputJsonValue,
          after: serialize(after) as Prisma.InputJsonValue,
        },
      });
      await writeAudit(tx, auth, meta, { action: 'payout_tier.updated', entityType: 'campaign', entityId: campaignId, before, after });
      return serialize(after);
    });
  }

  async removePayout(auth: OrgAuthContext, campaignId: string, tierId: string, meta: RequestMeta) {
    await this.campaigns.findAccessible(auth, campaignId);
    const tier = await this.prisma.campaignPayout.findFirst({ where: { id: tierId, campaignId } });
    if (!tier) throw AppError.notFound('Payout tier');
    await this.prisma.$transaction(async (tx) => {
      await tx.campaignPayout.delete({ where: { id: tierId } });
      await tx.payoutChangeLog.create({
        data: { organizationId: auth.organizationId, campaignId, campaignPayoutId: tierId, changedById: auth.user.id, changeType: 'tier_deleted', before: serialize(tier) as Prisma.InputJsonValue },
      });
      await writeAudit(tx, auth, meta, { action: 'payout_tier.deleted', entityType: 'campaign', entityId: campaignId, before: tier });
    });
  }

  async payoutHistory(auth: OrgAuthContext, campaignId: string) {
    await this.campaigns.findAccessible(auth, campaignId);
    const entries = await this.prisma.payoutChangeLog.findMany({ where: { campaignId }, orderBy: { createdAt: 'desc' }, take: 200 });
    const users = await this.prisma.user.findMany({
      where: { id: { in: entries.flatMap((e) => (e.changedById ? [e.changedById] : [])) } },
      select: { id: true, name: true, email: true },
    });
    return entries.map((entry) => ({ ...entry, changedBy: users.find((u) => u.id === entry.changedById) ?? null }));
  }

  // ─── Applications / publisher access ──────────────────────────────────────

  async listApplications(auth: OrgAuthContext, query: z.infer<typeof ListApplicationsQuery>) {
    const where: Prisma.CampaignPublisherWhereInput = {
      organizationId: auth.organizationId,
      campaign: campaignWhere(auth.scope),
      ...(auth.scope.restricted && auth.scope.publisherIds.length && !auth.scope.advertiserIds.length ? { publisherId: { in: auth.scope.publisherIds } } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.campaignId ? { campaignId: query.campaignId } : {}),
      ...(query.publisherId ? { publisherId: query.publisherId } : {}),
    };
    // Publishers also see their own pending/rejected applications, which campaignWhere would hide.
    if (isPublisherPortal(auth.scope)) {
      delete where.campaign;
      where.publisherId = { in: auth.scope.publisherIds };
    }
    const [items, total] = await Promise.all([
      this.prisma.campaignPublisher.findMany({
        where,
        include: {
          campaign: { select: { id: true, name: true, publicId: true, status: true } },
          publisher: { select: { id: true, companyName: true, publicId: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.campaignPublisher.count({ where }),
    ]);
    return paginated(items, total, query.page, query.pageSize);
  }

  /** Publisher portal: apply to a campaign from the marketplace. */
  async apply(auth: OrgAuthContext, campaignId: string, note: string, meta: RequestMeta) {
    const publisherId = auth.scope.publisherIds[0];
    if (!isPublisherPortal(auth.scope) || !publisherId) throw AppError.forbidden('Only publisher accounts can apply to campaigns');
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, organizationId: auth.organizationId, status: 'active', visibility: { in: ['public', 'approval_required'] } },
    });
    if (!campaign) throw AppError.notFound('Campaign');
    const existing = await this.prisma.campaignPublisher.findUnique({ where: { campaignId_publisherId: { campaignId, publisherId } } });
    if (existing) throw AppError.conflict(`You already have a ${existing.status} application for this campaign`);
    const application = await this.prisma.campaignPublisher.create({
      data: {
        organizationId: auth.organizationId,
        campaignId,
        publisherId,
        applicationNote: note,
        status: campaign.visibility === 'public' ? 'approved' : 'pending',
        decidedAt: campaign.visibility === 'public' ? new Date() : null,
      },
    });
    await writeAudit(this.prisma, auth, meta, { action: 'application.submitted', entityType: 'campaign', entityId: campaignId, after: application });
    await this.deps.publisher.publishLinksWhere({ campaignId, publisherId });
    if (application.status === 'pending') {
      this.deps.notifier.emit({
        organizationId: auth.organizationId,
        type: 'application.submitted',
        title: `New application for ${campaign.name}`,
        body: note ? `Note from the publisher: ${note}` : '',
        link: '/ntrack/campaigns/applications',
        subject: { advertiserId: campaign.advertiserId, publisherId },
        actorUserId: auth.user.id,
      });
    }
    return application;
  }

  /** Admin/advertiser: grant, block or reset a publisher's access to a campaign directly. */
  async assign(auth: OrgAuthContext, campaignId: string, input: z.infer<typeof AssignPublisherBody>, meta: RequestMeta) {
    await this.campaigns.findAccessible(auth, campaignId);
    if (isPublisherPortal(auth.scope)) throw AppError.forbidden();
    const publisher = await this.prisma.publisher.findFirst({ where: { id: input.publisherId, organizationId: auth.organizationId } });
    if (!publisher) throw AppError.badRequest('Unknown publisher');
    const decided = input.status !== 'pending';
    const application = await this.prisma.campaignPublisher.upsert({
      where: { campaignId_publisherId: { campaignId, publisherId: input.publisherId } },
      create: {
        organizationId: auth.organizationId,
        campaignId,
        publisherId: input.publisherId,
        status: input.status,
        decisionNote: input.note,
        decidedAt: decided ? new Date() : null,
        decidedById: decided ? auth.user.id : null,
      },
      update: { status: input.status, decisionNote: input.note, decidedAt: decided ? new Date() : null, decidedById: decided ? auth.user.id : null },
    });
    await writeAudit(this.prisma, auth, meta, { action: `application.${input.status}`, entityType: 'campaign', entityId: campaignId, summary: publisher.companyName, after: application });
    await this.deps.publisher.publishLinksWhere({ campaignId, publisherId: input.publisherId });
    if (decided) await this.notifyDecision(auth, campaignId, input.publisherId, input.status, input.note);
    return application;
  }

  async decide(auth: OrgAuthContext, applicationId: string, input: z.infer<typeof ApplicationDecisionBody>, meta: RequestMeta) {
    if (isPublisherPortal(auth.scope)) throw AppError.forbidden();
    const application = await this.prisma.campaignPublisher.findFirst({ where: { id: applicationId, organizationId: auth.organizationId } });
    if (!application) throw AppError.notFound('Application');
    await this.campaigns.findAccessible(auth, application.campaignId);
    const updated = await this.prisma.campaignPublisher.update({
      where: { id: applicationId },
      data: { status: input.status, decisionNote: input.note, decidedAt: new Date(), decidedById: auth.user.id },
    });
    await writeAudit(this.prisma, auth, meta, {
      action: `application.${input.status}`,
      entityType: 'campaign',
      entityId: application.campaignId,
      summary: input.note,
      before: { status: application.status },
      after: { status: updated.status },
    });
    await this.deps.publisher.publishLinksWhere({ campaignId: application.campaignId, publisherId: application.publisherId });
    await this.notifyDecision(auth, application.campaignId, application.publisherId, input.status, input.note);
    return updated;
  }

  private async notifyDecision(auth: OrgAuthContext, campaignId: string, publisherId: string, status: string, note: string | undefined) {
    if (status === 'pending') return;
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { name: true } });
    const verb = status === 'approved' ? 'approved' : status === 'blocked' ? 'blocked' : 'rejected';
    this.deps.notifier.emit({
      organizationId: auth.organizationId,
      type: 'application.decided',
      title: `Your access to ${campaign?.name ?? 'a campaign'} was ${verb}`,
      body: note ?? '',
      link: status === 'approved' ? `/ntrack/campaigns/${campaignId}` : '/ntrack/campaigns',
      subject: { publisherId },
      actorUserId: auth.user.id,
    });
  }

  // ─── Publisher marketplace ────────────────────────────────────────────────

  async marketplace(auth: OrgAuthContext, query: { page: number; pageSize: number; search?: string; category?: string }) {
    const publisherId = auth.scope.publisherIds[0];
    const where: Prisma.CampaignWhereInput = {
      organizationId: auth.organizationId,
      status: 'active',
      visibility: { in: ['public', 'approval_required'] },
      ...(query.category ? { category: query.category } : {}),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.campaign.findMany({
        where,
        select: {
          id: true,
          publicId: true,
          name: true,
          description: true,
          category: true,
          vertical: true,
          previewUrl: true,
          visibility: true,
          payoutModel: true,
          currency: true,
          defaultPayout: true,
          geoAllowed: true,
          devices: true,
          allowedTrafficTypes: true,
          restrictedTrafficTypes: true,
          conversionGoal: true,
          attributionWindowHours: true,
          endsAt: true,
          advertiser: { select: { companyName: true } },
          publishers: publisherId ? { where: { publisherId }, select: { status: true } } : false,
        },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.campaign.count({ where }),
    ]);
    return paginated(
      items.map(({ publishers, ...campaign }) => ({
        ...serialize(campaign),
        applicationStatus: (publishers as Array<{ status: string }> | undefined)?.[0]?.status ?? null,
      })),
      total,
      query.page,
      query.pageSize
    );
  }
}
