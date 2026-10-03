import type { Redis } from 'ioredis';
import {
  REDIS_KEYS,
  type AdvertiserSnapshot,
  type CampaignSnapshot,
  type ConversionIntake,
  type ClickContext,
  type ClickEvent,
  type DomainSnapshot,
  type LinkSnapshot,
} from '@ntrack/shared';

/**
 * Everything the tracker reads or writes. The Redis implementation is used in production; the
 * in-memory one backs unit and route tests so the redirect path can be tested without Redis.
 */
export interface TrackerStore {
  getDomainAndLink(hostname: string, slug: string): Promise<[DomainSnapshot | null, LinkSnapshot | null]>;
  getCampaign(campaignId: string): Promise<CampaignSnapshot | null>;
  /** Marks a visit; returns whether it is the first in the unique window and whether it repeats within the duplicate window. */
  markVisit(linkId: string, fingerprint: string, uniqueTtlSeconds: number, duplicateTtlSeconds: number): Promise<{ isUnique: boolean; isDuplicate: boolean }>;
  getDailyClicks(campaignId: string, day: string): Promise<number>;
  /** Counts this visitor's click on the campaign for the local day and returns the new total. */
  incrementVisitorFrequency(campaignId: string, fingerprint: string, day: string): Promise<number>;
  recordClick(event: ClickEvent, context: ClickContext, contextTtlSeconds: number, capKey: string | null): Promise<void>;
  getClickContext(clickId: string): Promise<ClickContext | null>;
  getAdvertiser(advertiserId: string): Promise<AdvertiserSnapshot | null>;
  enqueueConversion(intake: ConversionIntake): Promise<void>;
  ping(): Promise<boolean>;
}

const parse = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export class RedisTrackerStore implements TrackerStore {
  constructor(private readonly redis: Redis) {}

  async getDomainAndLink(hostname: string, slug: string): Promise<[DomainSnapshot | null, LinkSnapshot | null]> {
    const [domain, link] = await this.redis.mget(REDIS_KEYS.domain(hostname), REDIS_KEYS.link(slug));
    return [parse<DomainSnapshot>(domain ?? null), parse<LinkSnapshot>(link ?? null)];
  }

  async getCampaign(campaignId: string): Promise<CampaignSnapshot | null> {
    return parse<CampaignSnapshot>(await this.redis.get(REDIS_KEYS.campaign(campaignId)));
  }

  async markVisit(linkId: string, fingerprint: string, uniqueTtlSeconds: number, duplicateTtlSeconds: number) {
    const results = await this.redis
      .multi()
      .set(REDIS_KEYS.uniqueClick(linkId, fingerprint), '1', 'EX', Math.max(uniqueTtlSeconds, 1), 'NX')
      .set(REDIS_KEYS.duplicateBurst(linkId, fingerprint), '1', 'EX', Math.max(duplicateTtlSeconds, 1), 'NX')
      .exec();
    const isUnique = results?.[0]?.[1] === 'OK';
    const isDuplicate = results?.[1]?.[1] !== 'OK';
    return { isUnique, isDuplicate };
  }

  async getDailyClicks(campaignId: string, day: string): Promise<number> {
    return Number((await this.redis.get(REDIS_KEYS.dailyClicks(campaignId, day))) ?? 0);
  }

  async incrementVisitorFrequency(campaignId: string, fingerprint: string, day: string): Promise<number> {
    const key = REDIS_KEYS.visitorFrequency(campaignId, fingerprint, day);
    const results = await this.redis.multi().incr(key).expire(key, 60 * 60 * 48).exec();
    const failure = results?.find(([error]) => error);
    if (failure?.[0]) throw failure[0];
    return Number(results?.[0]?.[1] ?? 0);
  }

  async recordClick(event: ClickEvent, context: ClickContext, contextTtlSeconds: number, capKey: string | null): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.xadd(REDIS_KEYS.clickStream, '*', 'e', JSON.stringify(event));
    pipeline.set(REDIS_KEYS.click(event.clickId), JSON.stringify(context), 'EX', Math.max(contextTtlSeconds, 3600));
    if (capKey) {
      pipeline.incr(capKey);
      pipeline.expire(capKey, 60 * 60 * 48);
    }
    const results = await pipeline.exec();
    const failure = results?.find(([error]) => error);
    if (failure?.[0]) throw failure[0];
  }

  async getClickContext(clickId: string): Promise<ClickContext | null> {
    return parse<ClickContext>(await this.redis.get(REDIS_KEYS.click(clickId)));
  }

  async getAdvertiser(advertiserId: string): Promise<AdvertiserSnapshot | null> {
    return parse<AdvertiserSnapshot>(await this.redis.get(REDIS_KEYS.advertiser(advertiserId)));
  }

  async enqueueConversion(intake: ConversionIntake): Promise<void> {
    await this.redis.xadd(REDIS_KEYS.conversionStream, '*', 'c', JSON.stringify(intake));
  }

  async ping(): Promise<boolean> {
    return (await this.redis.ping()) === 'PONG';
  }
}

export class MemoryTrackerStore implements TrackerStore {
  readonly domains = new Map<string, DomainSnapshot>();
  readonly links = new Map<string, LinkSnapshot>();
  readonly campaigns = new Map<string, CampaignSnapshot>();
  readonly visits = new Set<string>();
  readonly counters = new Map<string, number>();
  readonly events: ClickEvent[] = [];
  readonly contexts = new Map<string, ClickContext>();
  readonly advertisers = new Map<string, AdvertiserSnapshot>();
  readonly conversions: ConversionIntake[] = [];

  async getDomainAndLink(hostname: string, slug: string): Promise<[DomainSnapshot | null, LinkSnapshot | null]> {
    return [this.domains.get(hostname) ?? null, this.links.get(slug) ?? null];
  }

  async getCampaign(campaignId: string) {
    return this.campaigns.get(campaignId) ?? null;
  }

  async markVisit(linkId: string, fingerprint: string) {
    const key = `${linkId}:${fingerprint}`;
    const seen = this.visits.has(key);
    this.visits.add(key);
    return { isUnique: !seen, isDuplicate: seen };
  }

  async getDailyClicks(campaignId: string, day: string) {
    return this.counters.get(REDIS_KEYS.dailyClicks(campaignId, day)) ?? 0;
  }

  async incrementVisitorFrequency(campaignId: string, fingerprint: string, day: string) {
    const key = REDIS_KEYS.visitorFrequency(campaignId, fingerprint, day);
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async recordClick(event: ClickEvent, context: ClickContext, _ttl: number, capKey: string | null) {
    this.events.push(event);
    this.contexts.set(event.clickId, context);
    if (capKey) this.counters.set(capKey, (this.counters.get(capKey) ?? 0) + 1);
  }

  async getClickContext(clickId: string) {
    return this.contexts.get(clickId) ?? null;
  }

  async getAdvertiser(advertiserId: string) {
    return this.advertisers.get(advertiserId) ?? null;
  }

  async enqueueConversion(intake: ConversionIntake) {
    this.conversions.push(intake);
  }

  async ping() {
    return true;
  }
}
