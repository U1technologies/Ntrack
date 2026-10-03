import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DatacenterMatcher } from '@ntrack/shared';
import { buildTracker } from '../src/app';
import { MemoryTrackerStore } from '../src/services/tracker-store';
import { makeCampaign, makeDomain, makeLink } from './fixtures';

const config = { port: 0, redisUrl: '', hashSecret: 'test-secret', trustProxy: true, devHostOverride: '', logLevel: 'silent', datacenterRangesFile: '' };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/128 Safari/537.36';

describe('GET /c/:slug', () => {
  let store: MemoryTrackerStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = new MemoryTrackerStore();
    store.domains.set('trk.example.com', makeDomain());
    store.links.set('AbCdEf1234', makeLink());
    store.campaigns.set(makeCampaign().campaignId, makeCampaign());
    app = buildTracker(store, config);
    await app.ready();
  });
  afterEach(() => app.close());

  const click = (path: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: path, headers: { host: 'trk.example.com', 'user-agent': UA, 'cf-ipcountry': 'US', 'cf-connecting-ip': '203.0.113.9', ...headers } });

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('302s to the landing page with privacy headers and records the click', async () => {
    const response = await click('/c/AbCdEf1234?sub1=google&utm_source=fb', { referer: 'https://news.site/article?email=a@b.com' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toMatch(/^https:\/\/brand\.com\/offer\?aff=[0-9A-Z]{26}&s1=google$/);
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers['cache-control']).toContain('no-store');
    await flush();
    expect(store.events).toHaveLength(1);
    const [event] = store.events;
    expect(event).toMatchObject({ sub1: 'google', utmSource: 'fb', country: 'US', isValid: true, isUnique: true, ip: '203.0.113.0' });
    expect(event?.referrer).toBe('https://news.site/article');
    expect(store.contexts.get(event!.clickId)).toBeDefined();
  });

  it('serves /click/:slug exactly like the short /c/:slug path', async () => {
    const response = await click('/click/AbCdEf1234?sub1=ads')
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toMatch(/^https:\/\/brand\.com\/offer\?aff=[0-9A-Z]{26}&s1=ads$/)
    expect((await click('/click/!!bad')).statusCode).toBe(404)
  })

  it('returns 404 for a link served from a different tenant domain', async () => {
    store.domains.set('other.example.com', makeDomain({ domainId: '99999999-9999-4999-8999-999999999999', hostname: 'other.example.com' }));
    const response = await click('/c/AbCdEf1234', { host: 'other.example.com' });
    expect(response.statusCode).toBe(404);
    expect(response.headers.location).toBeUndefined();
  });

  it('returns 404 for unknown slugs and inactive domains without leaking destinations', async () => {
    expect((await click('/c/Unknown1234')).statusCode).toBe(404);
    store.domains.set('trk.example.com', makeDomain({ active: false }));
    const response = await click('/c/AbCdEf1234');
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('brand.com');
  });

  it('marks the second rapid click from the same visitor as a duplicate', async () => {
    await click('/c/AbCdEf1234');
    await click('/c/AbCdEf1234');
    await flush();
    expect(store.events.map((e) => [e.isUnique, e.invalidReason])).toEqual([
      [true, ''],
      [false, 'duplicate_click'],
    ]);
  });

  it('enforces the daily click cap', async () => {
    store.campaigns.set(makeCampaign().campaignId, makeCampaign({ dailyClickCap: 1 }));
    expect((await click('/c/AbCdEf1234')).statusCode).toBe(302);
    await flush();
    const second = await click('/c/AbCdEf1234', { 'user-agent': `${UA} other`, 'cf-connecting-ip': '198.51.100.20' });
    expect(second.statusCode).toBe(410);
  });

  it('does not record HEAD requests', async () => {
    const response = await app.inject({ method: 'HEAD', url: '/c/AbCdEf1234', headers: { host: 'trk.example.com', 'user-agent': UA } });
    expect(response.statusCode).toBe(302);
    await flush();
    expect(store.events).toHaveLength(0);
  });

  it('applies the frequency cap per visitor and day, and HEAD requests do not count', async () => {
    store.campaigns.set(makeCampaign().campaignId, makeCampaign({ frequencyCap: 2 }));
    await app.inject({ method: 'HEAD', url: '/c/AbCdEf1234', headers: { host: 'trk.example.com', 'user-agent': UA, 'cf-connecting-ip': '203.0.113.9' } });
    expect((await click('/c/AbCdEf1234')).statusCode).toBe(302);
    expect((await click('/c/AbCdEf1234')).statusCode).toBe(302);
    expect((await click('/c/AbCdEf1234')).statusCode).toBe(410);
    // A different visitor is unaffected.
    expect((await click('/c/AbCdEf1234', { 'cf-connecting-ip': '198.51.100.20' })).statusCode).toBe(302);
    await flush();
    expect(store.events.map((e) => e.invalidReason)).toContain('frequency_cap_reached');
  });

  it('enforces language targeting from the Accept-Language header', async () => {
    store.campaigns.set(makeCampaign().campaignId, makeCampaign({ allowedLanguages: ['hi'] }));
    expect((await click('/c/AbCdEf1234', { 'accept-language': 'en-US,en;q=0.9' })).statusCode).toBe(410);
    expect((await click('/c/AbCdEf1234', { 'accept-language': 'hi-IN,hi;q=0.9', 'cf-connecting-ip': '198.51.100.21' })).statusCode).toBe(302);
  });

  it('flags clicks from data-centre IPs without blocking the redirect', async () => {
    await app.close();
    app = buildTracker(store, config, { datacenter: new DatacenterMatcher(['203.0.113.0/24']) });
    await app.ready();
    const response = await click('/c/AbCdEf1234');
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('https://brand.com/offer');
    await flush();
    expect(store.events[0]).toMatchObject({ isValid: false, invalidReason: 'datacenter_ip' });
  });
});
