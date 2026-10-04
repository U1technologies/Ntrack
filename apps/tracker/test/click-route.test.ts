import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DatacenterMatcher, REDIS_KEYS } from '@ntrack/shared';
import { buildTracker } from '../src/app';
import { MemoryTrackerStore } from '../src/services/tracker-store';
import { makeCampaign, makeDomain, makeLink } from './fixtures';

const config = { port: 0, redisUrl: '', hashSecret: 'test-secret', trustProxy: true, proxySecret: '', devHostOverride: '', logLevel: 'silent', datacenterRangesFile: '' };
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

describe('clicks forwarded by the website (nextagmedia.com/click via Vercel)', () => {
  const SECRET = 'a'.repeat(64);
  const proxied = { ...config, trustProxy: false, proxySecret: SECRET };
  let store: MemoryTrackerStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = new MemoryTrackerStore();
    store.domains.set('nextagmedia.com', makeDomain({ hostname: 'nextagmedia.com' }));
    store.links.set('AbCdEf1234', makeLink());
    store.campaigns.set(makeCampaign().campaignId, makeCampaign());
    app = buildTracker(store, proxied);
    await app.ready();
  });
  afterEach(() => app.close());

  const forwarded = (headers: Record<string, string>) =>
    app.inject({
      method: 'GET',
      url: '/click/AbCdEf1234?sub1=ads',
      headers: {
        host: 'ntrack-tracker.onrender.com',
        'user-agent': UA,
        'x-ntrack-host': 'nextagmedia.com',
        'x-ntrack-client-ip': '198.51.100.77',
        'x-ntrack-country': 'IN',
        'x-ntrack-city': 'New%20Delhi',
        ...headers,
      },
    });
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('uses the visitor host, IP and country sent with the right secret', async () => {
    const response = await forwarded({ 'x-ntrack-proxy-secret': SECRET });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toMatch(/^https:\/\/brand\.com\/offer\?aff=[0-9A-Z]{26}&s1=ads$/);
    await flush();
    expect(store.events[0]).toMatchObject({ country: 'IN', ip: '198.51.100.0', city: 'New Delhi' });
  });

  it('ignores forwarded headers without the secret, so the visitor host is not trusted', async () => {
    expect((await forwarded({})).statusCode).toBe(404);
    expect((await forwarded({ 'x-ntrack-proxy-secret': 'b'.repeat(64) })).statusCode).toBe(404);
  });

  it('falls back to the connection IP when the forwarded IP is not an IP address', async () => {
    const response = await forwarded({ 'x-ntrack-proxy-secret': SECRET, 'x-ntrack-client-ip': 'not-an-ip' });
    expect(response.statusCode).toBe(302);
    await flush();
    expect(store.events[0]?.ip).not.toBe('not-an-ip');
  });
});

describe('market-style links: /click?campaign_id=&pub_id= and force_transparent', () => {
  let store: MemoryTrackerStore;
  let app: FastifyInstance;
  const domain = makeDomain();

  beforeEach(async () => {
    store = new MemoryTrackerStore();
    store.domains.set('trk.example.com', domain);
    store.links.set('AbCdEf1234', makeLink());
    store.campaigns.set(makeCampaign().campaignId, makeCampaign());
    store.pairs.set(REDIS_KEYS.linkPair(domain.domainId, 'cmp_TEST000001', 'pub_TEST000001'), 'AbCdEf1234');
    app = buildTracker(store, config);
    await app.ready();
  });
  afterEach(() => app.close());

  const click = (path: string) => app.inject({ method: 'GET', url: path, headers: { host: 'trk.example.com', 'user-agent': UA, 'cf-ipcountry': 'US', 'cf-connecting-ip': '203.0.113.9' } });

  it('resolves campaign_id and pub_id to the publisher link and redirects like /click/:slug', async () => {
    const response = await click('/click?campaign_id=cmp_TEST000001&pub_id=pub_TEST000001&sub1=ads');
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toMatch(/^https:\/\/brand\.com\/offer\?aff=[0-9A-Z]{26}&s1=ads$/);
  });

  it('returns 404 for an unknown pair, a malformed ID, or another tenant domain', async () => {
    expect((await click('/click?campaign_id=cmp_TEST000001&pub_id=pub_OTHER00001')).statusCode).toBe(404);
    expect((await click('/click?campaign_id=1813&pub_id=1')).statusCode).toBe(404);
    expect((await click('/click')).statusCode).toBe(404);
  });

  it('follows url= with force_transparent=true, as a plain 302, only to allowed hosts', async () => {
    const ok = await click('/click?force_transparent=true&campaign_id=cmp_TEST000001&pub_id=pub_TEST000001&url=https%3A%2F%2Fbrand.com%2Fsale%3Fgclid%3Dx');
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toBe('https://brand.com/sale?gclid=x');
    const foreign = await click('/click?force_transparent=true&campaign_id=cmp_TEST000001&pub_id=pub_TEST000001&url=https%3A%2F%2Fevil.example%2F');
    expect(foreign.statusCode).toBe(400);
    expect(foreign.headers.location).toBeUndefined();
  });

  it('uses 302 for force_transparent even when the campaign is set to an HTML 200 page', async () => {
    store.campaigns.set(makeCampaign().campaignId, makeCampaign({ redirectResponse: 'html_200' }));
    const response = await click('/click/AbCdEf1234?force_transparent=true&url=https%3A%2F%2Fbrand.com%2F');
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('https://brand.com/');
  });

  it('ignores url= without force_transparent on a standard campaign', async () => {
    const response = await click('/click/AbCdEf1234?url=https%3A%2F%2Fbrand.com%2Fother');
    expect(response.headers.location).toMatch(/^https:\/\/brand\.com\/offer/);
  });
});
