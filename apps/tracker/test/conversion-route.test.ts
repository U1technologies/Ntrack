import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ClickContext } from '@ntrack/shared';
import { buildTracker } from '../src/app';
import { MemoryTrackerStore } from '../src/services/tracker-store';
import { ADVERTISER_ID, CAMPAIGN_ID, DOMAIN_ID, LINK_ID, ORG, PUBLISHER_ID } from './fixtures';

const config = { port: 0, redisUrl: '', hashSecret: 'test-secret', trustProxy: false, proxySecret: '', devHostOverride: '', logLevel: 'silent', datacenterRangesFile: '' };
const CLICK = '01J9Z3QK4T8W2M6N7P5R0S1V2X';
const TOKEN = 'advertiser-secret-token';

const context: ClickContext = {
  clickId: CLICK,
  gaid: '',
  idfa: '',
  appName: '',
  ts: Date.now(),
  organizationId: ORG,
  campaignId: CAMPAIGN_ID,
  publisherId: PUBLISHER_ID,
  advertiserId: ADVERTISER_ID,
  linkId: LINK_ID,
  domainId: DOMAIN_ID,
  sub1: '',
  sub2: '',
  sub3: '',
  sub4: '',
  sub5: '',
  source: '',
  country: 'US',
  deviceType: 'desktop',
  externalClickId: '',
  isValid: true,
  invalidReason: '',
  visitorId: 'v1',
  referrerDomain: '',
};

describe('conversion intake', () => {
  let store: MemoryTrackerStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = new MemoryTrackerStore();
    store.contexts.set(CLICK, context);
    store.advertisers.set(ADVERTISER_ID, {
      v: 1,
      advertiserId: ADVERTISER_ID,
      organizationId: ORG,
      postbackTokenHash: createHash('sha256').update(TOKEN).digest('hex'),
      active: true,
    });
    app = buildTracker(store, config);
    await app.ready();
  });
  afterEach(() => app.close());

  it('accepts a valid S2S postback and queues the conversion with parsed fields', async () => {
    const response = await app.inject({ method: 'GET', url: `/pb?click_id=${CLICK}&token=${TOKEN}&event=Lead&txn_id=ORD-1&amount=49.90&currency=usd&plan=pro` });
    expect(response.statusCode).toBe(202);
    expect(store.conversions[0]).toMatchObject({ source: 's2s', clickId: CLICK, event: 'lead', transactionId: 'ORD-1', saleAmount: '49.90', currency: 'USD', customParams: { plan: 'pro' } });
  });

  it('serves the documented public paths (/postback, /pixel, /ntrack.js) like the short ones', async () => {
    expect((await app.inject({ method: 'GET', url: `/postback?click_id=${CLICK}&token=${TOKEN}&event=sale&txn_id=ORD-P` })).statusCode).toBe(202);
    expect((await app.inject({ method: 'POST', url: '/postback', headers: { 'content-type': 'application/json' }, payload: { click_id: CLICK, token: TOKEN, event: 'lead' } })).statusCode).toBe(202);
    const pixel = await app.inject({ method: 'GET', url: `/pixel?click_id=${CLICK}&event=sale&txn_id=ORD-X` });
    expect(pixel.headers['content-type']).toBe('image/gif');
    const script = await app.inject({ method: 'GET', url: '/ntrack.js', headers: { host: 'trk.example.com' } });
    expect(script.statusCode).toBe(200);
    expect(script.body).toContain("'https://trk.example.com/pixel?'");
    expect((await app.inject({ method: 'GET', url: '/js/ntrack.js', headers: { host: 'trk.example.com' } })).body).toBe(script.body);
    expect(store.conversions.map((c) => c.source)).toEqual(['s2s', 's2s', 'pixel']);
  });

  it('accepts form-encoded POST postbacks', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/pb',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `click_id=${CLICK}&token=${TOKEN}&event=sale`,
    });
    expect(response.statusCode).toBe(202);
  });

  it('rejects a wrong token, an unknown click and a malformed click ID', async () => {
    expect((await app.inject({ method: 'GET', url: `/pb?click_id=${CLICK}&token=wrong` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/pb?click_id=01J9Z3QK4T8W2M6N7P5R0S1V2Y&token=${TOKEN}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/pb?click_id=nope&token=${TOKEN}` })).statusCode).toBe(400);
    expect(store.conversions).toHaveLength(0);
  });

  it('rejects postbacks for inactive advertisers', async () => {
    store.advertisers.set(ADVERTISER_ID, { ...store.advertisers.get(ADVERTISER_ID)!, active: false });
    expect((await app.inject({ method: 'GET', url: `/pb?click_id=${CLICK}&token=${TOKEN}` })).statusCode).toBe(403);
  });

  it('ignores non-numeric amounts instead of storing garbage', async () => {
    await app.inject({ method: 'GET', url: `/pb?click_id=${CLICK}&token=${TOKEN}&amount=12abc` });
    expect(store.conversions[0]?.saleAmount).toBeNull();
  });

  it('serves the pixel and reads the click ID from the first-party cookie', async () => {
    const response = await app.inject({ method: 'GET', url: '/px?event=purchase', headers: { cookie: `ntclk=${CLICK}` } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/gif');
    expect(store.conversions[0]).toMatchObject({ source: 'pixel', event: 'purchase' });
  });

  it('still serves the pixel for unknown clicks but queues nothing', async () => {
    const response = await app.inject({ method: 'GET', url: '/px?click_id=01J9Z3QK4T8W2M6N7P5R0S1V2Y' });
    expect(response.statusCode).toBe(200);
    expect(store.conversions).toHaveLength(0);
  });
});
