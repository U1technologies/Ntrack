import type { PrismaClient } from '@ntrack/db';

export interface EntityNames {
  campaign: Map<string, string>;
  publisher: Map<string, string>;
  advertiser: Map<string, string>;
  domain: Map<string, string>;
}

const UUID = /^[0-9a-f-]{36}$/i;
const ids = (values: Iterable<unknown>) => [...new Set([...values].filter((v): v is string => typeof v === 'string' && UUID.test(v)))];

/** Resolves analytics UUIDs to display names, scoped to one organization. */
export const resolveEntityNames = async (
  prisma: PrismaClient,
  organizationId: string,
  input: { campaign?: Iterable<unknown>; publisher?: Iterable<unknown>; advertiser?: Iterable<unknown>; domain?: Iterable<unknown> }
): Promise<EntityNames> => {
  const [campaigns, publishers, advertisers, domains] = await Promise.all([
    input.campaign ? prisma.campaign.findMany({ where: { organizationId, id: { in: ids(input.campaign) } }, select: { id: true, name: true } }) : [],
    input.publisher ? prisma.publisher.findMany({ where: { organizationId, id: { in: ids(input.publisher) } }, select: { id: true, companyName: true } }) : [],
    input.advertiser ? prisma.advertiser.findMany({ where: { organizationId, id: { in: ids(input.advertiser) } }, select: { id: true, companyName: true } }) : [],
    input.domain ? prisma.trackingDomain.findMany({ where: { organizationId, id: { in: ids(input.domain) } }, select: { id: true, hostname: true } }) : [],
  ]);
  return {
    campaign: new Map(campaigns.map((c) => [c.id, c.name])),
    publisher: new Map(publishers.map((p) => [p.id, p.companyName])),
    advertiser: new Map(advertisers.map((a) => [a.id, a.companyName])),
    domain: new Map(domains.map((d) => [d.id, d.hostname])),
  };
};
