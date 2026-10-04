import type { z } from 'zod';
import type { Prisma, TrackingLink } from '@ntrack/db';
import { generateLinkSlug, generatePublicId, renderTemplate, validateDestinationUrl } from '@ntrack/shared';
import { AppError } from '../../lib/errors';
import { paginated } from '../../lib/response';
import { campaignWhere, isPublisherPortal, trackingLinkWhere } from '../../services/access-scope';
import { writeAudit } from '../../services/audit';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';
import type { BulkLinksBody, CreateLinkBody, ListLinksQuery, TemplateBody, UpdateLinkBody } from './links.schemas';

const linkInclude = {
  campaign: { select: { id: true, name: true, publicId: true, redirectMode: true, destinationParam: true, status: true } },
  publisher: { select: { id: true, companyName: true, publicId: true } },
  domain: { select: { id: true, hostname: true, status: true } },
  landingPage: { select: { id: true, name: true, publicId: true } },
} satisfies Prisma.TrackingLinkInclude;

type LinkWithRelations = Prisma.TrackingLinkGetPayload<{ include: typeof linkInclude }>;

type UrlCampaign = { publicId: string; redirectMode: string; destinationParam: string };
const PRESET_PARAMS = ['sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'source'] as const;

/** Short link: /click/{slug}. Transparent-mode links include the destination parameter (e.g. Google's {lpurl}). */
export const buildShortUrl = (link: Pick<TrackingLink, 'slug'>, hostname: string, campaign: UrlCampaign) => {
  const base = `https://${hostname}/click/${link.slug}`;
  return campaign.redirectMode === 'transparent' ? `${base}?${campaign.destinationParam}={lpurl}` : base;
};

/**
 * Market-style link (the format networks such as Trackier use): campaign and publisher IDs in the
 * query, the link's saved sub IDs as visible parameters, and for transparent campaigns
 * force_transparent=true followed by the transparency parameter.
 */
export const buildTrackingUrl = (
  link: Partial<Pick<TrackingLink, (typeof PRESET_PARAMS)[number]>>,
  hostname: string,
  campaign: UrlCampaign,
  publisherPublicId: string
) => {
  const params = [`campaign_id=${encodeURIComponent(campaign.publicId)}`, `pub_id=${encodeURIComponent(publisherPublicId)}`];
  for (const key of PRESET_PARAMS) if (link[key]) params.push(`${key}=${encodeURIComponent(link[key] as string)}`);
  if (campaign.redirectMode === 'transparent') params.push('force_transparent=true', `${campaign.destinationParam}={lpurl}`);
  return `https://${hostname}/click?${params.join('&')}`;
};

const presentLink = (link: LinkWithRelations) => ({
  ...link,
  trackingUrl: buildTrackingUrl(link, link.domain.hostname, link.campaign, link.publisher.publicId),
  shortUrl: buildShortUrl(link, link.domain.hostname, link.campaign),
});

type LinkInput = z.infer<typeof CreateLinkBody>;

export class LinksService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma() {
    return this.deps.prisma;
  }

  /** Validates campaign, publisher, domain and landing page together and returns the resolved records. */
  private async resolveContext(auth: OrgAuthContext, input: Pick<LinkInput, 'campaignId' | 'domainId' | 'landingPageId'>, publisherId: string | undefined) {
    const effectivePublisherId = isPublisherPortal(auth.scope) ? auth.scope.publisherIds[0] : publisherId;
    if (!effectivePublisherId) throw AppError.badRequest('Choose a publisher');

    const campaign = await this.prisma.campaign.findFirst({
      where: {
        id: input.campaignId,
        organizationId: auth.organizationId,
        // Publishers may only generate links for campaigns they are approved on.
        ...(isPublisherPortal(auth.scope) ? campaignWhere(auth.scope) : {}),
      },
      include: { domains: { select: { domainId: true } }, landingPages: { where: { active: true } }, publishers: { where: { publisherId: effectivePublisherId } } },
    });
    if (!campaign) throw AppError.notFound('Campaign');
    if (campaign.status === 'archived') throw AppError.badRequest('Archived campaigns cannot get new links');

    const [publisher, domain] = await Promise.all([
      this.prisma.publisher.findFirst({ where: { id: effectivePublisherId, organizationId: auth.organizationId } }),
      this.prisma.trackingDomain.findFirst({ where: { id: input.domainId, organizationId: auth.organizationId } }),
    ]);
    if (!publisher) throw AppError.badRequest('Unknown publisher');
    if (!domain) throw AppError.badRequest('Unknown tracking domain');
    if (domain.status !== 'active') throw AppError.badRequest('The tracking domain must be verified and active');
    if (campaign.domains.length > 0 && !campaign.domains.some((d) => d.domainId === domain.id)) {
      throw AppError.badRequest('This campaign is not configured for the selected tracking domain');
    }
    if (domain.advertiserId && domain.advertiserId !== campaign.advertiserId) throw AppError.badRequest('This tracking domain is reserved for another advertiser');
    if (input.landingPageId && !campaign.landingPages.some((page) => page.id === input.landingPageId)) throw AppError.badRequest('Unknown landing page');

    const application = campaign.publishers[0];
    const publisherApproved =
      publisher.status === 'active' && (application?.status === 'approved' || (campaign.visibility === 'public' && !['blocked', 'rejected'].includes(application?.status ?? '')));
    return { campaign, publisher, domain, publisherApproved };
  }

  private extraParams(input: Pick<LinkInput, 'utm' | 'customParams'>): Record<string, string> {
    const utm = Object.fromEntries(Object.entries(input.utm).filter(([, value]) => value));
    return { ...input.customParams, ...utm };
  }

  async preview(auth: OrgAuthContext, input: LinkInput) {
    const { campaign, domain, publisher, publisherApproved } = await this.resolveContext(auth, input, input.publisherId);
    const page = campaign.landingPages.find((p) => p.id === input.landingPageId) ?? campaign.landingPages.find((p) => p.isDefault) ?? campaign.landingPages[0];
    const trackingUrl = buildTrackingUrl(input, domain.hostname, campaign, publisher.publicId);
    if (campaign.redirectMode === 'transparent') {
      return { trackingUrl, destinationPreview: null, publisherApproved, note: 'Transparent mode: the destination is the URL passed in the destination parameter.' };
    }
    if (!page) return { trackingUrl, destinationPreview: null, publisherApproved, note: 'The campaign has no active landing page.' };
    const rendered = renderTemplate(
      page.url,
      {
        click_id: '01J9Z3QK4T8W2M6N7P5R0S1V2X',
        campaign_id: campaign.publicId,
        publisher_id: publisher.publicId,
        subid1: input.sub1,
        subid2: input.sub2,
        subid3: input.sub3,
        subid4: input.sub4,
        subid5: input.sub5,
        source: input.source,
      },
      { context: 'destination', encoding: 'query' }
    );
    const url = new URL(rendered);
    for (const [key, value] of Object.entries(this.extraParams(input))) url.searchParams.set(key, value);
    const validation = validateDestinationUrl(url.toString(), {
      allowedHosts: [...campaign.allowedHosts, ...campaign.landingPages.map((p) => new URL(p.url.replace(/\{[^}]+\}/g, 'x')).hostname)],
      requireHttps: campaign.requireHttps,
    });
    return { trackingUrl, destinationPreview: url.toString(), destinationValid: validation.ok, publisherApproved, note: null };
  }

  private linkData(auth: OrgAuthContext, ctx: Awaited<ReturnType<LinksService['resolveContext']>>, input: Omit<LinkInput, 'campaignId' | 'domainId' | 'publisherId'>) {
    return {
      publicId: generatePublicId('lnk'),
      slug: generateLinkSlug(),
      organizationId: auth.organizationId,
      campaignId: ctx.campaign.id,
      publisherId: ctx.publisher.id,
      domainId: ctx.domain.id,
      landingPageId: input.landingPageId ?? null,
      name: input.name,
      sub1: input.sub1,
      sub2: input.sub2,
      sub3: input.sub3,
      sub4: input.sub4,
      sub5: input.sub5,
      source: input.source,
      extraParams: this.extraParams(input),
      createdById: auth.user.id,
    } satisfies Prisma.TrackingLinkUncheckedCreateInput;
  }

  async create(auth: OrgAuthContext, input: LinkInput, meta: RequestMeta) {
    const ctx = await this.resolveContext(auth, input, input.publisherId);
    const link = await this.prisma.trackingLink.create({ data: this.linkData(auth, ctx, input), include: linkInclude });
    await writeAudit(this.prisma, auth, meta, { action: 'link.created', entityType: 'tracking_link', entityId: link.id, summary: `${link.campaign.name} / ${link.publisher.companyName}` });
    await this.deps.publisher.publishLink(link.id);
    return { ...presentLink(link), publisherApproved: ctx.publisherApproved };
  }

  async bulkCreate(auth: OrgAuthContext, input: z.infer<typeof BulkLinksBody>, meta: RequestMeta) {
    const contexts = new Map<string, Awaited<ReturnType<LinksService['resolveContext']>>>();
    const data: Prisma.TrackingLinkUncheckedCreateInput[] = [];
    for (const row of input.rows) {
      const key = row.publisherId ?? 'self';
      let ctx = contexts.get(key);
      if (!ctx) {
        ctx = await this.resolveContext(auth, input, row.publisherId);
        contexts.set(key, ctx);
      }
      data.push(this.linkData(auth, ctx, { ...row, landingPageId: input.landingPageId, utm: input.utm, customParams: input.customParams }));
    }
    const slugs = data.map((d) => d.slug);
    await this.prisma.trackingLink.createMany({ data });
    const links = await this.prisma.trackingLink.findMany({ where: { slug: { in: slugs } }, include: linkInclude });
    await writeAudit(this.prisma, auth, meta, { action: 'link.bulk_created', entityType: 'tracking_link', summary: `${links.length} links for campaign ${input.campaignId}` });
    await this.deps.publisher.publishLinksWhere({ slug: { in: slugs } });
    return links.map(presentLink);
  }

  private whereFor(auth: OrgAuthContext, query: Partial<z.infer<typeof ListLinksQuery>>): Prisma.TrackingLinkWhereInput {
    return {
      organizationId: auth.organizationId,
      ...trackingLinkWhere(auth.scope),
      ...(query.campaignId ? { campaignId: query.campaignId } : {}),
      ...(query.publisherId ? { publisherId: query.publisherId } : {}),
      ...(query.domainId ? { domainId: query.domainId } : {}),
      ...(query.active ? { active: query.active === 'true' } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { slug: query.search },
              { sub1: { contains: query.search, mode: 'insensitive' } },
              { campaign: { name: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
  }

  async list(auth: OrgAuthContext, query: z.infer<typeof ListLinksQuery>) {
    const where = this.whereFor(auth, query);
    const [items, total] = await Promise.all([
      this.prisma.trackingLink.findMany({ where, include: linkInclude, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.trackingLink.count({ where }),
    ]);
    return paginated(items.map(presentLink), total, query.page, query.pageSize);
  }

  async exportCsv(auth: OrgAuthContext, query: Partial<z.infer<typeof ListLinksQuery>>) {
    const links = await this.prisma.trackingLink.findMany({ where: this.whereFor(auth, query), include: linkInclude, orderBy: { createdAt: 'desc' }, take: 50_000 });
    const escape = (value: string) => {
      // Neutralise spreadsheet formula injection, then quote.
      const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const header = ['link_id', 'name', 'campaign', 'campaign_id', 'publisher', 'publisher_id', 'domain', 'tracking_url', 'sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'source', 'active', 'created_at'];
    const rows = links.map((link) => {
      const presented = presentLink(link);
      return [
        link.publicId,
        link.name,
        link.campaign.name,
        link.campaign.publicId,
        link.publisher.companyName,
        link.publisher.publicId,
        link.domain.hostname,
        presented.trackingUrl,
        link.sub1,
        link.sub2,
        link.sub3,
        link.sub4,
        link.sub5,
        link.source,
        String(link.active),
        link.createdAt.toISOString(),
      ]
        .map(escape)
        .join(',');
    });
    return [header.join(','), ...rows].join('\n');
  }

  async update(auth: OrgAuthContext, id: string, input: z.infer<typeof UpdateLinkBody>, meta: RequestMeta) {
    const before = await this.prisma.trackingLink.findFirst({ where: { id, organizationId: auth.organizationId, ...trackingLinkWhere(auth.scope) } });
    if (!before) throw AppError.notFound('Tracking link');
    if (input.landingPageId && !(await this.prisma.landingPage.findFirst({ where: { id: input.landingPageId, campaignId: before.campaignId } }))) {
      throw AppError.badRequest('Unknown landing page');
    }
    const after = await this.prisma.trackingLink.update({ where: { id }, data: input, include: linkInclude });
    await writeAudit(this.prisma, auth, meta, { action: 'link.updated', entityType: 'tracking_link', entityId: id, before, after });
    await this.deps.publisher.publishLink(id);
    return presentLink(after);
  }

  listTemplates(auth: OrgAuthContext) {
    return this.prisma.linkTemplate.findMany({ where: { organizationId: auth.organizationId }, orderBy: { name: 'asc' } });
  }

  async saveTemplate(auth: OrgAuthContext, input: z.infer<typeof TemplateBody>) {
    return this.prisma.linkTemplate.upsert({
      where: { organizationId_name: { organizationId: auth.organizationId, name: input.name } },
      create: { organizationId: auth.organizationId, name: input.name, config: input.config as Prisma.InputJsonValue, createdById: auth.user.id },
      update: { config: input.config as Prisma.InputJsonValue },
    });
  }

  async removeTemplate(auth: OrgAuthContext, id: string) {
    const { count } = await this.prisma.linkTemplate.deleteMany({ where: { id, organizationId: auth.organizationId } });
    if (count === 0) throw AppError.notFound('Template');
  }
}
