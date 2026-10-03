import type { Prisma } from '@ntrack/db';
import type { DataScope } from '@ntrack/analytics';
import { AppError } from '../lib/errors';
import type { AccessScope, OrgAuthContext } from '../types';

/**
 * Translates an access scope into Prisma filters. Every list/detail query for tenant data goes
 * through these helpers, together with the organization ID, so data isolation lives in one place.
 *
 * Each helper returns its condition inside a top-level `AND`, so spreading it next to other
 * filters (`{ id, OR: search, ...scopeWhere }`) can never overwrite or be overwritten by them.
 * Callers must not add their own top-level `AND` to the same object.
 */

const noneMatch = { in: [] as string[] };
const scoped = <T>(condition: T): { AND: T[] } => ({ AND: [condition] });

export const advertiserWhere = (scope: AccessScope): Prisma.AdvertiserWhereInput =>
  scope.restricted ? scoped<Prisma.AdvertiserWhereInput>({ id: scope.advertiserIds.length ? { in: scope.advertiserIds } : noneMatch }) : {};

export const publisherWhere = (scope: AccessScope): Prisma.PublisherWhereInput =>
  scope.restricted ? scoped<Prisma.PublisherWhereInput>({ id: scope.publisherIds.length ? { in: scope.publisherIds } : noneMatch }) : {};

/** Campaigns of the user's advertisers, or campaigns the user's publishers are approved on. */
export const campaignWhere = (scope: AccessScope): Prisma.CampaignWhereInput => {
  if (!scope.restricted) return {};
  const or: Prisma.CampaignWhereInput[] = [];
  if (scope.advertiserIds.length) or.push({ advertiserId: { in: scope.advertiserIds } });
  if (scope.publisherIds.length) or.push({ publishers: { some: { publisherId: { in: scope.publisherIds }, status: 'approved' } } });
  return scoped<Prisma.CampaignWhereInput>(or.length ? { OR: or } : { id: noneMatch });
};

export const trackingLinkWhere = (scope: AccessScope): Prisma.TrackingLinkWhereInput => {
  if (!scope.restricted) return {};
  const or: Prisma.TrackingLinkWhereInput[] = [];
  if (scope.advertiserIds.length) or.push({ campaign: { advertiserId: { in: scope.advertiserIds } } });
  if (scope.publisherIds.length) or.push({ publisherId: { in: scope.publisherIds } });
  return scoped<Prisma.TrackingLinkWhereInput>(or.length ? { OR: or } : { id: noneMatch });
};

/** Conversions tied to the user's advertisers or publishers. */
export const conversionWhere = (scope: AccessScope): Prisma.ConversionWhereInput => {
  if (!scope.restricted) return {};
  const or: Prisma.ConversionWhereInput[] = [];
  if (scope.advertiserIds.length) or.push({ advertiserId: { in: scope.advertiserIds } });
  if (scope.publisherIds.length) or.push({ publisherId: { in: scope.publisherIds } });
  return scoped<Prisma.ConversionWhereInput>(or.length ? { OR: or } : { id: noneMatch });
};

/** Publishers see only their own postbacks; organization roles see all. */
export const postbackWhere = (scope: AccessScope): Prisma.PostbackWhereInput => {
  if (!scope.restricted) return {};
  return scoped<Prisma.PostbackWhereInput>(scope.publisherIds.length ? { publisherId: { in: scope.publisherIds } } : { id: noneMatch });
};

export const canAccessAdvertiser = (scope: AccessScope, advertiserId: string) => !scope.restricted || scope.advertiserIds.includes(advertiserId);
export const canAccessPublisher = (scope: AccessScope, publisherId: string) => !scope.restricted || scope.publisherIds.includes(publisherId);

export const assertAdvertiserAccess = (scope: AccessScope, advertiserId: string) => {
  if (!canAccessAdvertiser(scope, advertiserId)) throw AppError.notFound('Advertiser');
};
export const assertPublisherAccess = (scope: AccessScope, publisherId: string) => {
  if (!canAccessPublisher(scope, publisherId)) throw AppError.notFound('Publisher');
};

export const isPublisherPortal = (scope: AccessScope) => scope.type === 'publisher';
export const isAdvertiserPortal = (scope: AccessScope) => scope.type === 'advertiser';

export const analyticsScope = (auth: OrgAuthContext): DataScope => ({
  organizationId: auth.organizationId,
  restricted: auth.scope.restricted,
  advertiserIds: auth.scope.advertiserIds,
  publisherIds: auth.scope.publisherIds,
});
