import type { Redis } from 'ioredis';
import { prisma, type Prisma, type PrismaClient } from '@ntrack/db';
import {
  DEFAULT_PARAM_MAP,
  REDIS_KEYS,
  REFERRER_POLICIES,
  SNAPSHOT_VERSION,
  normalizeHostname,
  type AdvertiserSnapshot,
  type CampaignSnapshot,
  type DeviceType,
  type DomainSnapshot,
  type LinkSnapshot,
  type ReferrerPolicy,
  type TrackingParamMap,
} from '@ntrack/shared';
import { computeBudgetUsage } from './budget';

export * from './budget';

/**
 * Builds the Redis snapshots the tracker reads on every click and keeps them in sync with
 * PostgreSQL. The API calls the targeted publish functions after each committed change; the
 * workers call `syncAllSnapshots` periodically to repair drift (e.g. a Redis flush or a failed
 * publish), so the tracker never needs to query PostgreSQL.
 */

const campaignInclude = {
  advertiser: { select: { publicId: true } },
  landingPages: { where: { active: true }, orderBy: { createdAt: 'asc' } },
  domains: { select: { domainId: true } },
  organization: { include: { settings: true } },
} satisfies Prisma.CampaignInclude;

type CampaignWithRelations = Prisma.CampaignGetPayload<{ include: typeof campaignInclude }>;

const linkInclude = {
  publisher: { select: { publicId: true, status: true } },
  landingPage: { select: { publicId: true, active: true } },
  campaign: {
    select: {
      visibility: true,
      publishers: { select: { publisherId: true, status: true } },
    },
  },
} satisfies Prisma.TrackingLinkInclude;

type LinkWithRelations = Prisma.TrackingLinkGetPayload<{ include: typeof linkInclude }>;

const toReferrerPolicy = (value: string | null | undefined, fallback: ReferrerPolicy): ReferrerPolicy =>
  (REFERRER_POLICIES as readonly string[]).includes(value ?? '') ? (value as ReferrerPolicy) : fallback;

const hostOf = (url: string): string | null => {
  try {
    return normalizeHostname(new URL(url).hostname);
  } catch {
    return null;
  }
};

export const buildCampaignSnapshot = (campaign: CampaignWithRelations, budgetExhausted = false): CampaignSnapshot => {
  const settings = campaign.organization.settings;
  const landingPages = Object.fromEntries(campaign.landingPages.map((page) => [page.publicId, page.url]));
  const defaultPage = campaign.landingPages.find((page) => page.isDefault) ?? campaign.landingPages[0];
  // Landing page hosts are implicitly allowed; explicit entries cover deep links and transparent mode.
  const allowedHosts = [
    ...new Set([
      ...campaign.allowedHosts.map(normalizeHostname),
      ...campaign.landingPages.map((page) => hostOf(page.url)).filter((host): host is string => Boolean(host)),
    ]),
  ];
  const orgPolicy = toReferrerPolicy(settings?.referrerPolicy, 'strict-origin-when-cross-origin');

  return {
    v: SNAPSHOT_VERSION,
    campaignId: campaign.id,
    publicId: campaign.publicId,
    organizationId: campaign.organizationId,
    advertiserId: campaign.advertiserId,
    advertiserPublicId: campaign.advertiser.publicId,
    status: campaign.status,
    startsAt: campaign.startsAt?.toISOString() ?? null,
    endsAt: campaign.endsAt?.toISOString() ?? null,
    dailyClickCap: campaign.dailyClickCap,
    allowedCountries: campaign.geoAllowed,
    blockedCountries: campaign.geoBlocked,
    allowedDevices: campaign.devices as DeviceType[],
    allowedOperatingSystems: campaign.operatingSystems,
    allowedBrowsers: campaign.browsers,
    allowedLanguages: campaign.languages,
    frequencyCap: campaign.frequencyCap,
    budgetExhausted,
    fallbackUrl: campaign.fallbackUrl,
    attributionWindowHours: campaign.attributionWindowHours,
    timezone: campaign.organization.timezone,
    landingPages,
    defaultLandingPageId: defaultPage?.publicId ?? '',
    allowedHosts,
    requireHttps: campaign.requireHttps && (settings?.requireHttpsDestinations ?? true),
    allowDeepLinks: campaign.allowDeepLinks,
    redirectMode: campaign.redirectMode,
    destinationParam: campaign.destinationParam,
    transparentClickIdParam: campaign.transparentClickIdParam,
    uniqueClickWindowHours: settings?.uniqueClickWindowHours ?? 24,
    clickCookieDays: settings?.clickCookieDays ?? 0,
    duplicateClickWindowSeconds: settings?.duplicateClickWindowSeconds ?? 10,
    domainIds: campaign.domains.map((d) => d.domainId),
    referrerPolicy: toReferrerPolicy(campaign.referrerPolicy, orgPolicy),
    collectReferrer: settings?.collectReferrer ?? true,
    ipStorage: settings?.ipStorage ?? 'truncated',
    paramMap: { ...DEFAULT_PARAM_MAP, ...((settings?.paramMap ?? {}) as Partial<TrackingParamMap>) },
  };
};

export const buildLinkSnapshot = (link: LinkWithRelations): LinkSnapshot => {
  const publisherActive = link.publisher.status === 'active';
  const application = link.campaign.publishers.find((entry) => entry.publisherId === link.publisherId);
  const approvedForCampaign =
    application?.status === 'approved' || (link.campaign.visibility === 'public' && application?.status !== 'blocked' && application?.status !== 'rejected');
  const extraParams = (link.extraParams ?? {}) as Record<string, string>;

  return {
    v: SNAPSHOT_VERSION,
    linkId: link.id,
    slug: link.slug,
    organizationId: link.organizationId,
    campaignId: link.campaignId,
    publisherId: link.publisherId,
    publisherPublicId: link.publisher.publicId,
    active: link.active,
    publisherApproved: publisherActive && approvedForCampaign,
    landingPageId: link.landingPage?.active ? link.landingPage.publicId : null,
    domainId: link.domainId,
    presets: Object.fromEntries(
      (['sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'source'] as const).filter((key) => link[key]).map((key) => [key, link[key]])
    ),
    extraParams,
  };
};

export const buildDomainSnapshot = (domain: { id: string; organizationId: string; hostname: string; status: string }): DomainSnapshot => ({
  v: SNAPSHOT_VERSION,
  domainId: domain.id,
  organizationId: domain.organizationId,
  hostname: domain.hostname,
  active: domain.status === 'active',
});

export const buildAdvertiserSnapshot = (advertiser: { id: string; organizationId: string; status: string; postbackTokenHash: string | null }): AdvertiserSnapshot => ({
  v: SNAPSHOT_VERSION,
  advertiserId: advertiser.id,
  organizationId: advertiser.organizationId,
  postbackTokenHash: advertiser.postbackTokenHash,
  active: advertiser.status === 'active',
});

export class ConfigPublisher {
  constructor(
    private readonly redis: Redis,
    private readonly db: PrismaClient = prisma
  ) {}

  async publishDomain(domainId: string): Promise<void> {
    const domain = await this.db.trackingDomain.findUnique({ where: { id: domainId } });
    if (!domain) return;
    await this.redis.set(REDIS_KEYS.domain(domain.hostname), JSON.stringify(buildDomainSnapshot(domain)));
  }

  async removeDomain(hostname: string): Promise<void> {
    await this.redis.del(REDIS_KEYS.domain(hostname));
  }

  async publishAdvertiser(advertiserId: string): Promise<void> {
    const advertiser = await this.db.advertiser.findUnique({ where: { id: advertiserId } });
    if (!advertiser) {
      await this.redis.del(REDIS_KEYS.advertiser(advertiserId));
      return;
    }
    await this.redis.set(REDIS_KEYS.advertiser(advertiser.id), JSON.stringify(buildAdvertiserSnapshot(advertiser)));
  }

  async publishCampaign(campaignId: string): Promise<void> {
    const campaign = await this.db.campaign.findUnique({ where: { id: campaignId }, include: campaignInclude });
    if (!campaign) {
      await this.redis.del(REDIS_KEYS.campaign(campaignId));
      return;
    }
    const budgets = await this.budgetsFor([campaign]);
    await this.redis.set(REDIS_KEYS.campaign(campaign.id), JSON.stringify(buildCampaignSnapshot(campaign, budgets.get(campaign.id)?.exhausted)));
  }

  /**
   * Re-checks campaigns that have a budget and republishes the ones whose exhausted state changed.
   * Returns the campaigns that just became exhausted so callers can notify their owners.
   */
  async refreshBudgets(): Promise<{ checked: number; changed: number; exhausted: Array<{ campaignId: string; organizationId: string; advertiserId: string; name: string }> }> {
    const campaigns = await this.db.campaign.findMany({
      where: { status: 'active', OR: [{ monthlyBudget: { not: null } }, { totalBudget: { not: null } }] },
      include: campaignInclude,
    });
    if (campaigns.length === 0) return { checked: 0, changed: 0, exhausted: [] };
    const budgets = await this.budgetsFor(campaigns);
    const current = await this.redis.mget(...campaigns.map((c) => REDIS_KEYS.campaign(c.id)));
    const pipeline = this.redis.pipeline();
    const exhausted: Array<{ campaignId: string; organizationId: string; advertiserId: string; name: string }> = [];
    let changed = 0;
    campaigns.forEach((campaign, index) => {
      const next = budgets.get(campaign.id)?.exhausted ?? false;
      const raw = current[index];
      const previous = raw ? (JSON.parse(raw) as Partial<CampaignSnapshot>).budgetExhausted === true : false;
      if (raw && previous === next) return;
      changed += 1;
      if (next && !previous) exhausted.push({ campaignId: campaign.id, organizationId: campaign.organizationId, advertiserId: campaign.advertiserId, name: campaign.name });
      pipeline.set(REDIS_KEYS.campaign(campaign.id), JSON.stringify(buildCampaignSnapshot(campaign, next)));
    });
    if (changed > 0) await pipeline.exec();
    return { checked: campaigns.length, changed, exhausted };
  }

  /** Budget state per campaign; campaigns without budgets are absent from the map. */
  async budgetsFor(campaigns: CampaignWithRelations[]) {
    return computeBudgetUsage(
      this.db,
      campaigns.map((c) => ({ id: c.id, monthlyBudget: c.monthlyBudget, totalBudget: c.totalBudget, timezone: c.organization.timezone }))
    );
  }

  async publishLink(linkId: string): Promise<void> {
    const link = await this.db.trackingLink.findUnique({ where: { id: linkId }, include: linkInclude });
    if (!link) return;
    await this.redis.set(REDIS_KEYS.link(link.slug), JSON.stringify(buildLinkSnapshot(link)));
  }

  async removeLink(slug: string): Promise<void> {
    await this.redis.del(REDIS_KEYS.link(slug));
  }

  /** Re-publishes links affected by publisher status or application changes. */
  async publishLinksWhere(where: Prisma.TrackingLinkWhereInput): Promise<number> {
    let count = 0;
    let cursor: string | undefined;
    for (;;) {
      const links = await this.db.trackingLink.findMany({
        where,
        include: linkInclude,
        take: 500,
        orderBy: { id: 'asc' },
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (links.length === 0) break;
      const pipeline = this.redis.pipeline();
      links.forEach((link) => pipeline.set(REDIS_KEYS.link(link.slug), JSON.stringify(buildLinkSnapshot(link))));
      await pipeline.exec();
      count += links.length;
      cursor = links[links.length - 1]?.id;
    }
    return count;
  }

  /** Re-publishes every campaign of an organization (after organization settings change). */
  async publishOrganizationCampaigns(organizationId: string): Promise<void> {
    const campaigns = await this.db.campaign.findMany({ where: { organizationId }, include: campaignInclude });
    const budgets = await this.budgetsFor(campaigns);
    const pipeline = this.redis.pipeline();
    campaigns.forEach((campaign) =>
      pipeline.set(REDIS_KEYS.campaign(campaign.id), JSON.stringify(buildCampaignSnapshot(campaign, budgets.get(campaign.id)?.exhausted)))
    );
    await pipeline.exec();
  }

  /** Full reconciliation: rewrites every snapshot and deletes snapshots with no backing row. */
  async syncAllSnapshots(): Promise<{ domains: number; advertisers: number; campaigns: number; links: number; removed: number }> {
    const advertisers = await this.db.advertiser.findMany({ select: { id: true, organizationId: true, status: true, postbackTokenHash: true } });
    const advertiserKeys = new Set(advertisers.map((a) => REDIS_KEYS.advertiser(a.id)));
    const advertiserPipeline = this.redis.pipeline();
    advertisers.forEach((a) => advertiserPipeline.set(REDIS_KEYS.advertiser(a.id), JSON.stringify(buildAdvertiserSnapshot(a))));
    await advertiserPipeline.exec();

    const domains = await this.db.trackingDomain.findMany();
    const domainKeys = new Set(domains.map((d) => REDIS_KEYS.domain(d.hostname)));
    const domainPipeline = this.redis.pipeline();
    domains.forEach((d) => domainPipeline.set(REDIS_KEYS.domain(d.hostname), JSON.stringify(buildDomainSnapshot(d))));
    await domainPipeline.exec();

    const campaigns = await this.db.campaign.findMany({ include: campaignInclude });
    const campaignKeys = new Set(campaigns.map((c) => REDIS_KEYS.campaign(c.id)));
    const budgets = await this.budgetsFor(campaigns);
    const campaignPipeline = this.redis.pipeline();
    campaigns.forEach((c) => campaignPipeline.set(REDIS_KEYS.campaign(c.id), JSON.stringify(buildCampaignSnapshot(c, budgets.get(c.id)?.exhausted))));
    await campaignPipeline.exec();

    const links = await this.publishLinksWhere({});
    const linkSlugs = new Set(
      (await this.db.trackingLink.findMany({ select: { slug: true } })).map((l) => REDIS_KEYS.link(l.slug))
    );

    let removed = 0;
    removed += await this.removeStale(REDIS_KEYS.domain('*'), domainKeys);
    removed += await this.removeStale(REDIS_KEYS.campaign('*'), campaignKeys);
    removed += await this.removeStale(REDIS_KEYS.link('*'), linkSlugs);
    removed += await this.removeStale(REDIS_KEYS.advertiser('*'), advertiserKeys);
    await this.redis.set(REDIS_KEYS.configSyncedAt, new Date().toISOString());
    return { domains: domains.length, advertisers: advertisers.length, campaigns: campaigns.length, links, removed };
  }

  private async removeStale(pattern: string, keep: Set<string>): Promise<number> {
    let cursor = '0';
    let removed = 0;
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
      cursor = next;
      const stale = keys.filter((key) => !keep.has(key));
      if (stale.length > 0) removed += await this.redis.del(...stale);
    } while (cursor !== '0');
    return removed;
  }
}
