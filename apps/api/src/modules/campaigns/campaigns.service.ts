import type { z } from 'zod';
import type { Campaign, Prisma } from '@ntrack/db';
import { effectiveRedirectResponse, effectiveReferrerPolicy, generatePublicId, redirectTypeOf, type ConversionTrackingMethod } from '@ntrack/shared';
import { AppError } from '../../lib/errors';
import { paginated } from '../../lib/response';
import { serialize } from '../../lib/serialize';
import { assertAdvertiserAccess, campaignWhere, isAdvertiserPortal, isPublisherPortal } from '../../services/access-scope';
import { writeAudit } from '../../services/audit';
import { TOKEN_PLACEHOLDER, TRACKING_METHOD_NOTES, TRACKING_SETUP_NOTES, buildTrackingSnippets, canRevealPostbackToken } from '../../services/tracking-snippets';
import { validateLandingPageTemplate } from '../../services/destination-validation';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';
import {
  TRANSPARENT_NEEDS_302,
  transparentUses302,
  type BulkBody,
  type CreateCampaignBody,
  type LandingPageBody,
  type ListCampaignsQuery,
  type StatusBody,
  type UpdateCampaignBody,
} from './campaigns.schemas';

type CreateInput = z.infer<typeof CreateCampaignBody>;
type UpdateInput = z.infer<typeof UpdateCampaignBody>;

const listInclude = {
  advertiser: { select: { id: true, companyName: true, publicId: true } },
  _count: { select: { publishers: true, trackingLinks: true, landingPages: true } },
} satisfies Prisma.CampaignInclude;

const detailInclude = {
  advertiser: { select: { id: true, companyName: true, publicId: true } },
  landingPages: { orderBy: { createdAt: 'asc' } },
  domains: { include: { domain: { select: { id: true, hostname: true, status: true } } } },
  _count: { select: { publishers: true, trackingLinks: true } },
} satisfies Prisma.CampaignInclude;

/** Rate fields each audience may see: publishers never see revenue, advertisers never see payouts. */
export const presentCampaign = <T extends Partial<Campaign>>(campaign: T, auth: OrgAuthContext) => {
  const output: Record<string, unknown> = { ...serialize(campaign) };
  const canSeeRates = auth.permissions.has('payouts.view');
  if (isPublisherPortal(auth.scope) || !canSeeRates) delete output.defaultRevenue;
  if (isAdvertiserPortal(auth.scope) || (!canSeeRates && !isPublisherPortal(auth.scope))) delete output.defaultPayout;
  if (isPublisherPortal(auth.scope)) {
    delete output.monthlyBudget;
    delete output.totalBudget;
  }
  return output;
};

const toDate = (value: string | null | undefined) => (value === undefined ? undefined : value === null ? null : new Date(value));

export class CampaignsService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma() {
    return this.deps.prisma;
  }

  async findAccessible(auth: OrgAuthContext, id: string) {
    const campaign = await this.prisma.campaign.findFirst({ where: { id, organizationId: auth.organizationId, ...campaignWhere(auth.scope) } });
    if (!campaign) throw AppError.notFound('Campaign');
    return campaign;
  }

  /** Campaigns the user may change: advertiser-portal users only their own advertiser's. */
  private async findManageable(auth: OrgAuthContext, id: string) {
    const campaign = await this.findAccessible(auth, id);
    if (isPublisherPortal(auth.scope)) throw AppError.forbidden();
    return campaign;
  }

  async list(auth: OrgAuthContext, query: z.infer<typeof ListCampaignsQuery>) {
    const where: Prisma.CampaignWhereInput = {
      organizationId: auth.organizationId,
      ...campaignWhere(auth.scope),
      ...(query.status ? { status: query.status } : { status: { not: 'archived' } }),
      ...(query.advertiserId ? { advertiserId: query.advertiserId } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.search
        ? { OR: [{ name: { contains: query.search, mode: 'insensitive' } }, { publicId: query.search }, { advertiser: { companyName: { contains: query.search, mode: 'insensitive' } } }] }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.campaign.findMany({
        where,
        include: listInclude,
        orderBy: { [query.sort]: query.direction },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.campaign.count({ where }),
    ]);
    return paginated(
      items.map((campaign) => presentCampaign(campaign, auth)),
      total,
      query.page,
      query.pageSize
    );
  }

  async get(auth: OrgAuthContext, id: string) {
    await this.findAccessible(auth, id);
    const campaign = await this.prisma.campaign.findUniqueOrThrow({ where: { id }, include: detailInclude });
    return { ...presentCampaign(campaign, auth), effectiveRedirect: await this.effectiveRedirect(campaign) };
  }

  /**
   * Conversion code for this campaign's tracking method (and the other methods, so the page can
   * switch). Uses the campaign's own tracking domain when it has one, else the advertiser's or the
   * organization default, and the advertiser's postback token.
   */
  async trackingSetup(auth: OrgAuthContext, id: string) {
    await this.findAccessible(auth, id);
    const campaign = await this.prisma.campaign.findUniqueOrThrow({
      where: { id },
      select: { conversionTracking: true, conversionGoal: true, currency: true, advertiserId: true, domains: { select: { domain: { select: { hostname: true, status: true } } } } },
    });
    const advertiser = await this.prisma.advertiser.findUniqueOrThrow({ where: { id: campaign.advertiserId }, select: { postbackTokenEncrypted: true } });
    const ownDomain = campaign.domains.map((d) => d.domain).find((d) => d.status === 'active');
    const domain =
      ownDomain ??
      (await this.prisma.trackingDomain.findFirst({ where: { organizationId: auth.organizationId, status: 'active', advertiserId: campaign.advertiserId } })) ??
      (await this.prisma.trackingDomain.findFirst({ where: { organizationId: auth.organizationId, status: 'active' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] }));
    const stored = advertiser.postbackTokenEncrypted ? this.deps.secretBox.decrypt(advertiser.postbackTokenEncrypted) : null;
    const tokenVisible = canRevealPostbackToken(auth.permissions);
    const token = stored && !tokenVisible ? TOKEN_PLACEHOLDER : stored;
    const method = campaign.conversionTracking as ConversionTrackingMethod;
    return {
      method,
      domain: domain?.hostname ?? null,
      tokenVisible,
      snippets: buildTrackingSnippets(domain ? `https://${domain.hostname}` : null, token, campaign.conversionGoal, campaign.currency),
      methodNotes: TRACKING_METHOD_NOTES,
      notes: TRACKING_SETUP_NOTES,
    };
  }

  /**
   * What the tracker actually applies, resolved exactly as config sync does: campaign override,
   * else organization default; transparent campaigns are always 302.
   */
  private async effectiveRedirect(campaign: Pick<Campaign, 'organizationId' | 'redirectMode' | 'redirectResponse' | 'referrerPolicy'>) {
    const settings = await this.prisma.organizationSettings.findUnique({
      where: { organizationId: campaign.organizationId },
      select: { redirectResponse: true, referrerPolicy: true },
    });
    const response = effectiveRedirectResponse(campaign.redirectMode, campaign.redirectResponse, settings?.redirectResponse);
    const referrerPolicy = effectiveReferrerPolicy(campaign.referrerPolicy, settings?.referrerPolicy);
    return {
      response,
      referrerPolicy,
      type: redirectTypeOf(response, referrerPolicy),
      responseFromDefault: campaign.redirectMode !== 'transparent' && campaign.redirectResponse === null,
      referrerPolicyFromDefault: effectiveReferrerPolicy(campaign.referrerPolicy, null) !== campaign.referrerPolicy,
      forcedByGoogleAdsRule: campaign.redirectMode === 'transparent',
    };
  }

  private async assertDomains(auth: OrgAuthContext, domainIds: string[]) {
    if (domainIds.length === 0) return;
    const count = await this.prisma.trackingDomain.count({ where: { id: { in: domainIds }, organizationId: auth.organizationId } });
    if (count !== new Set(domainIds).size) throw AppError.badRequest('Some tracking domains do not exist');
  }

  private assertLandingPages(pages: Array<{ url: string }>, requireHttps: boolean) {
    for (const page of pages) {
      const error = validateLandingPageTemplate(page.url, requireHttps);
      if (error) throw AppError.badRequest(`Landing page "${page.url}": ${error}`);
    }
  }

  /** Users without campaigns.approve can submit but not activate. */
  private resolveInitialStatus(auth: OrgAuthContext, requested: CreateInput['status']) {
    if (requested === 'active' && !auth.permissions.has('campaigns.approve')) return 'pending';
    if (isAdvertiserPortal(auth.scope) && requested !== 'draft') return 'pending';
    return requested;
  }

  async create(auth: OrgAuthContext, input: CreateInput, meta: RequestMeta) {
    const advertiserId = isAdvertiserPortal(auth.scope) ? auth.scope.advertiserIds[0] : input.advertiserId;
    if (!advertiserId) throw AppError.forbidden();
    assertAdvertiserAccess(auth.scope, advertiserId);
    const advertiser = await this.prisma.advertiser.findFirst({ where: { id: advertiserId, organizationId: auth.organizationId } });
    if (!advertiser) throw AppError.badRequest('Unknown advertiser');
    await this.assertDomains(auth, input.domainIds);
    this.assertLandingPages(input.landingPages, input.requireHttps);

    const { landingPages, domainIds, startsAt, endsAt, status, ...fields } = input;
    const finalStatus = this.resolveInitialStatus(auth, status);
    const hasDefault = landingPages.some((page) => page.isDefault);

    const campaign = await this.prisma.$transaction(async (tx) => {
      const created = await tx.campaign.create({
        data: {
          ...fields,
          advertiserId,
          publicId: generatePublicId('cmp'),
          organizationId: auth.organizationId,
          status: finalStatus,
          startsAt: toDate(startsAt),
          endsAt: toDate(endsAt),
          createdById: auth.user.id,
          approvedAt: finalStatus === 'active' ? new Date() : null,
          approvedById: finalStatus === 'active' ? auth.user.id : null,
          landingPages: {
            create: landingPages.map((page, index) => ({
              ...page,
              isDefault: hasDefault ? page.isDefault : index === 0,
              publicId: generatePublicId('lp'),
              organizationId: auth.organizationId,
            })),
          },
          domains: { create: [...new Set(domainIds)].map((domainId) => ({ domainId })) },
        },
      });
      await tx.payoutChangeLog.create({
        data: {
          organizationId: auth.organizationId,
          campaignId: created.id,
          changedById: auth.user.id,
          changeType: 'default_rates_set',
          after: { payout: created.defaultPayout.toString(), revenue: created.defaultRevenue.toString(), currency: created.currency },
        },
      });
      await writeAudit(tx, auth, meta, { action: 'campaign.created', entityType: 'campaign', entityId: created.id, summary: created.name, after: created });
      return created;
    });
    await this.deps.publisher.publishCampaign(campaign.id);
    return this.get(auth, campaign.id);
  }

  async update(auth: OrgAuthContext, id: string, input: UpdateInput, meta: RequestMeta) {
    const before = await this.findManageable(auth, id);
    if (input.advertiserId && input.advertiserId !== before.advertiserId) {
      if (isAdvertiserPortal(auth.scope)) throw AppError.forbidden('You cannot move a campaign to another advertiser');
      assertAdvertiserAccess(auth.scope, input.advertiserId);
    }
    if (input.domainIds) await this.assertDomains(auth, input.domainIds);
    const ratesChanged =
      (input.defaultPayout !== undefined && input.defaultPayout !== before.defaultPayout.toString()) ||
      (input.defaultRevenue !== undefined && input.defaultRevenue !== before.defaultRevenue.toString());
    if (ratesChanged && !auth.permissions.has('payouts.manage')) throw AppError.forbidden('Changing rates requires the payout management permission');
    if (input.redirectMode === 'transparent' && (input.allowedHosts ?? before.allowedHosts).length === 0) {
      throw AppError.badRequest('Transparent redirects need at least one allowed destination host');
    }
    // A partial update can change either field alone, so check the combined result.
    const nextMode = input.redirectMode ?? before.redirectMode;
    const nextResponse = input.redirectResponse !== undefined ? input.redirectResponse : before.redirectResponse;
    if (!transparentUses302({ redirectMode: nextMode, redirectResponse: nextResponse })) {
      throw AppError.badRequest(TRANSPARENT_NEEDS_302, { fields: [{ path: 'redirectResponse', message: TRANSPARENT_NEEDS_302 }] });
    }

    const { domainIds, startsAt, endsAt, ...fields } = input;
    const after = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.campaign.update({ where: { id }, data: { ...fields, startsAt: toDate(startsAt), endsAt: toDate(endsAt) } });
      if (domainIds) {
        await tx.campaignDomain.deleteMany({ where: { campaignId: id } });
        await tx.campaignDomain.createMany({ data: [...new Set(domainIds)].map((domainId) => ({ campaignId: id, domainId })) });
      }
      if (ratesChanged) {
        await tx.payoutChangeLog.create({
          data: {
            organizationId: auth.organizationId,
            campaignId: id,
            changedById: auth.user.id,
            changeType: 'default_rates_changed',
            before: { payout: before.defaultPayout.toString(), revenue: before.defaultRevenue.toString() },
            after: { payout: updated.defaultPayout.toString(), revenue: updated.defaultRevenue.toString() },
          },
        });
      }
      await writeAudit(tx, auth, meta, { action: 'campaign.updated', entityType: 'campaign', entityId: id, summary: updated.name, before, after: updated });
      return updated;
    });
    await this.deps.publisher.publishCampaign(after.id);
    return this.get(auth, id);
  }

  async setStatus(auth: OrgAuthContext, id: string, input: z.infer<typeof StatusBody>, meta: RequestMeta) {
    const before = await this.findManageable(auth, id);
    const activating = input.status === 'active' && before.status !== 'active';
    if (activating && !auth.permissions.has('campaigns.approve')) throw AppError.forbidden('Activating a campaign requires approval permission');
    if (isAdvertiserPortal(auth.scope) && !['paused', 'pending', 'draft'].includes(input.status)) throw AppError.forbidden();
    if (activating) {
      const pages = await this.prisma.landingPage.count({ where: { campaignId: id, active: true } });
      if (pages === 0) throw AppError.badRequest('Add an active landing page before activating the campaign');
    }
    const firstApproval = activating && !before.approvedAt;
    const after = await this.prisma.campaign.update({
      where: { id },
      data: {
        status: input.status,
        archivedAt: input.status === 'archived' ? new Date() : null,
        ...(firstApproval ? { approvedAt: new Date(), approvedById: auth.user.id } : {}),
      },
    });
    await writeAudit(this.prisma, auth, meta, {
      action: `campaign.status.${input.status}`,
      entityType: 'campaign',
      entityId: id,
      summary: input.note || `${before.status} → ${input.status}`,
      before: { status: before.status },
      after: { status: after.status },
    });
    await this.deps.publisher.publishCampaign(id);
    return presentCampaign(after, auth);
  }

  async duplicate(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    await this.findManageable(auth, id);
    const source = await this.prisma.campaign.findUniqueOrThrow({ where: { id }, include: { landingPages: true, payouts: true, domains: true } });
    const { id: _id, publicId: _p, createdAt: _c, updatedAt: _u, approvedAt: _a, approvedById: _ab, archivedAt: _ar, landingPages, payouts, domains, ...fields } = source;
    const copy = await this.prisma.$transaction(async (tx) => {
      const created = await tx.campaign.create({
        data: {
          ...fields,
          name: `${source.name} (copy)`.slice(0, 160),
          publicId: generatePublicId('cmp'),
          status: 'draft',
          createdById: auth.user.id,
          landingPages: {
            create: landingPages.map(({ name, url, isDefault, active }) => ({ name, url, isDefault, active, publicId: generatePublicId('lp'), organizationId: auth.organizationId })),
          },
          payouts: {
            create: payouts.map(({ id: _pid, campaignId: _cid, createdAt: _pc, updatedAt: _pu, organizationId, ...tier }) => ({ ...tier, organizationId })),
          },
          domains: { create: domains.map(({ domainId }) => ({ domainId })) },
        },
      });
      await writeAudit(tx, auth, meta, { action: 'campaign.duplicated', entityType: 'campaign', entityId: created.id, summary: `Copied from ${source.publicId}` });
      return created;
    });
    await this.deps.publisher.publishCampaign(copy.id);
    return this.get(auth, copy.id);
  }

  async remove(auth: OrgAuthContext, id: string, confirmName: string, meta: RequestMeta) {
    const campaign = await this.findManageable(auth, id);
    if (!auth.permissions.has('campaigns.delete')) throw AppError.forbidden();
    if (confirmName !== campaign.name) throw AppError.badRequest('Type the campaign name exactly to confirm deletion');
    const links = await this.prisma.trackingLink.count({ where: { campaignId: id } });
    if (links > 0) throw AppError.conflict('This campaign has tracking links and click history. Archive it instead.');
    await this.prisma.campaign.delete({ where: { id } });
    await writeAudit(this.prisma, auth, meta, { action: 'campaign.deleted', entityType: 'campaign', entityId: id, summary: campaign.name, before: campaign });
    await this.deps.publisher.publishCampaign(id);
  }

  async bulk(auth: OrgAuthContext, input: z.infer<typeof BulkBody>, meta: RequestMeta) {
    if (isPublisherPortal(auth.scope) || isAdvertiserPortal(auth.scope)) throw AppError.forbidden();
    const campaigns = await this.prisma.campaign.findMany({ where: { id: { in: input.ids }, organizationId: auth.organizationId, ...campaignWhere(auth.scope) } });
    if (campaigns.length !== new Set(input.ids).size) throw AppError.badRequest('Some campaigns were not found');

    if (input.action === 'status') {
      if (input.status === 'active' && !auth.permissions.has('campaigns.approve')) throw AppError.forbidden();
      await this.prisma.campaign.updateMany({
        where: { id: { in: input.ids } },
        data: { status: input.status, archivedAt: input.status === 'archived' ? new Date() : null },
      });
    } else {
      const { endsAt, ...data } = input.data;
      await this.prisma.campaign.updateMany({ where: { id: { in: input.ids } }, data: { ...data, endsAt: toDate(endsAt) } });
    }
    await writeAudit(this.prisma, auth, meta, {
      action: `campaign.bulk_${input.action}`,
      entityType: 'campaign',
      summary: `${input.ids.length} campaigns`,
      after: input,
    });
    await Promise.all(input.ids.map((campaignId) => this.deps.publisher.publishCampaign(campaignId)));
    return { updated: input.ids.length };
  }

  // ─── Landing pages ────────────────────────────────────────────────────────

  async listLandingPages(auth: OrgAuthContext, campaignId: string) {
    await this.findAccessible(auth, campaignId);
    return this.prisma.landingPage.findMany({ where: { campaignId }, orderBy: { createdAt: 'asc' } });
  }

  async addLandingPage(auth: OrgAuthContext, campaignId: string, input: z.infer<typeof LandingPageBody>, meta: RequestMeta) {
    const campaign = await this.findManageable(auth, campaignId);
    this.assertLandingPages([input], campaign.requireHttps);
    const page = await this.prisma.$transaction(async (tx) => {
      if (input.isDefault) await tx.landingPage.updateMany({ where: { campaignId }, data: { isDefault: false } });
      const created = await tx.landingPage.create({ data: { ...input, campaignId, organizationId: auth.organizationId, publicId: generatePublicId('lp') } });
      await writeAudit(tx, auth, meta, { action: 'landing_page.created', entityType: 'campaign', entityId: campaignId, summary: input.url, after: created });
      return created;
    });
    await this.deps.publisher.publishCampaign(campaignId);
    return page;
  }

  async updateLandingPage(auth: OrgAuthContext, campaignId: string, pageId: string, input: Partial<z.infer<typeof LandingPageBody>>, meta: RequestMeta) {
    const campaign = await this.findManageable(auth, campaignId);
    const before = await this.prisma.landingPage.findFirst({ where: { id: pageId, campaignId } });
    if (!before) throw AppError.notFound('Landing page');
    if (input.url) this.assertLandingPages([{ url: input.url }], campaign.requireHttps);
    if (before.isDefault && (input.active === false || input.isDefault === false)) throw AppError.badRequest('Choose another default landing page first');
    const page = await this.prisma.$transaction(async (tx) => {
      if (input.isDefault) await tx.landingPage.updateMany({ where: { campaignId }, data: { isDefault: false } });
      const updated = await tx.landingPage.update({ where: { id: pageId }, data: input });
      await writeAudit(tx, auth, meta, { action: 'landing_page.updated', entityType: 'campaign', entityId: campaignId, before, after: updated });
      return updated;
    });
    await this.deps.publisher.publishCampaign(campaignId);
    return page;
  }

  async removeLandingPage(auth: OrgAuthContext, campaignId: string, pageId: string, meta: RequestMeta) {
    await this.findManageable(auth, campaignId);
    const page = await this.prisma.landingPage.findFirst({ where: { id: pageId, campaignId } });
    if (!page) throw AppError.notFound('Landing page');
    if (page.isDefault) throw AppError.badRequest('The default landing page cannot be deleted');
    await this.prisma.landingPage.delete({ where: { id: pageId } });
    await writeAudit(this.prisma, auth, meta, { action: 'landing_page.deleted', entityType: 'campaign', entityId: campaignId, before: page });
    await this.deps.publisher.publishCampaign(campaignId);
    await this.deps.publisher.publishLinksWhere({ landingPageId: null, campaignId });
  }
}
