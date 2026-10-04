import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CampaignSnapshot } from '@ntrack/shared';
import { buildTracker } from '../src/app';
import { buildHtmlRedirect } from '../src/services/html-redirect';
import { MemoryTrackerStore } from '../src/services/tracker-store';
import { makeCampaign, makeDomain, makeLink } from './fixtures';

const config = { port: 0, redisUrl: '', hashSecret: 'test-secret', trustProxy: true, proxySecret: '', devHostOverride: '', logLevel: 'silent', datacenterRangesFile: '' };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/128 Safari/537.36';

describe('redirect response types', () => {
  let store: MemoryTrackerStore;
  let app: FastifyInstance;

  const useCampaign = (overrides: Partial<CampaignSnapshot>) => store.campaigns.set(makeCampaign().campaignId, makeCampaign(overrides));
  const click = (path = '/c/AbCdEf1234', method: 'GET' | 'HEAD' = 'GET') =>
    app.inject({ method, url: path, headers: { host: 'trk.example.com', 'user-agent': UA, 'cf-ipcountry': 'US', 'cf-connecting-ip': '203.0.113.9' } });
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(async () => {
    store = new MemoryTrackerStore();
    store.domains.set('trk.example.com', makeDomain());
    store.links.set('AbCdEf1234', makeLink());
    useCampaign({});
    app = buildTracker(store, config);
    await app.ready();
  });
  afterEach(() => app.close());

  it('302: answers with a Location header and the configured Referrer-Policy', async () => {
    const response = await click();
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toMatch(/^https:\/\/brand\.com\/offer\?aff=/);
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers['x-ntrack-response']).toBe('redirect_302');
    expect(response.body).toBe('');
    await flush();
    expect(store.events[0]).toMatchObject({ responseType: 'redirect_302', httpStatus: 302, referrerPolicy: 'strict-origin-when-cross-origin', usedFallback: false });
  });

  it('302 with hide referrer: reuses the Referrer-Policy setting (no-referrer)', async () => {
    useCampaign({ referrerPolicy: 'no-referrer' });
    const response = await click();
    expect(response.statusCode).toBe(302);
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    await flush();
    expect(store.events[0]).toMatchObject({ responseType: 'redirect_302', httpStatus: 302, referrerPolicy: 'no-referrer' });
  });

  it('200: serves a transparent HTML page that navigates to the same validated destination', async () => {
    useCampaign({ redirectResponse: 'html_200' });
    const response = await click();
    expect(response.statusCode).toBe(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['x-robots-tag']).toContain('noindex');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    const csp = response.headers['content-security-policy'] as string;
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(csp).toContain("default-src 'none'");
    expect(nonce).toBeTruthy();
    const destination = /<a id="go" href="([^"]+)"/.exec(response.body)?.[1]?.replace(/&amp;/g, '&');
    expect(destination).toMatch(/^https:\/\/brand\.com\/offer\?aff=[0-9A-Z]{26}&s1=$/);
    expect(response.body).toContain('<p class="host">brand.com</p>');
    expect(response.body).toContain(`<meta http-equiv="refresh" content="0;url=${destination!.replace(/&/g, '&amp;')}">`);
    expect(response.body).toContain(`<script nonce="${nonce}">window.location.replace(${JSON.stringify(destination).replace(/&/g, '\\u0026')});</script>`);
    expect(response.body).toContain('<meta name="referrer" content="strict-origin-when-cross-origin">');
    expect(response.body).not.toContain('rel="noreferrer"');
    await flush();
    expect(store.events[0]).toMatchObject({ responseType: 'html_200', httpStatus: 200, referrerPolicy: 'strict-origin-when-cross-origin', destinationUrl: destination });
  });

  it('200 with hide referrer: no-referrer in the header, the page meta and the link', async () => {
    useCampaign({ redirectResponse: 'html_200', referrerPolicy: 'no-referrer' });
    const response = await click();
    expect(response.statusCode).toBe(200);
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.body).toContain('<meta name="referrer" content="no-referrer">');
    expect(response.body).toContain('rel="noreferrer"');
    await flush();
    expect(store.events[0]).toMatchObject({ responseType: 'html_200', httpStatus: 200, referrerPolicy: 'no-referrer' });
  });

  it('serves the identical page to every user agent (no cloaking)', async () => {
    useCampaign({ redirectResponse: 'html_200' });
    const strip = (body: string) => body.replace(/nonce="[^"]+"/g, '').replace(/aff=[0-9A-Z]{26}/g, 'aff=X').replace(/aff%3D[0-9A-Z]{26}/g, '');
    const browser = await click();
    const bot = await app.inject({ method: 'GET', url: '/c/AbCdEf1234', headers: { host: 'trk.example.com', 'user-agent': 'AdsBot-Google (+http://www.google.com/adsbot.html)', 'cf-connecting-ip': '198.51.100.7' } });
    expect(bot.statusCode).toBe(browser.statusCode);
    expect(strip(bot.body)).toBe(strip(browser.body));
  });

  it('Google Ads transparent campaigns always get HTTP 302, even if html_200 reaches the snapshot', async () => {
    useCampaign({ redirectMode: 'transparent', redirectResponse: 'html_200' });
    const response = await click('/c/AbCdEf1234?url=https%3A%2F%2Fbrand.com%2Flanding%3Fgclid%3Dabc');
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('https://brand.com/landing?gclid=abc');
    expect(response.headers['x-ntrack-response']).toBe('redirect_302');
    await flush();
    expect(store.events[0]).toMatchObject({ responseType: 'redirect_302', httpStatus: 302, redirectMode: 'transparent' });
  });

  it('uses the HTML page for the fallback URL too, and logs fallback usage', async () => {
    useCampaign({ redirectResponse: 'html_200', status: 'paused', fallbackUrl: 'https://fallback.example.com/offers' });
    const response = await click();
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('href="https://fallback.example.com/offers"');
    await flush();
    expect(store.events[0]).toMatchObject({ responseType: 'html_200', httpStatus: 200, usedFallback: true, invalidReason: 'campaign_inactive' });
  });

  it('logs rejected clicks as error responses with their HTTP status', async () => {
    useCampaign({ redirectResponse: 'html_200', status: 'paused' });
    const response = await click();
    expect(response.statusCode).toBe(410);
    await flush();
    expect(store.events[0]).toMatchObject({ responseType: 'error', httpStatus: 410, referrerPolicy: '', usedFallback: false });
  });

  it('answers HEAD for an HTML 200 link without recording a click', async () => {
    useCampaign({ redirectResponse: 'html_200' });
    const response = await click('/c/AbCdEf1234', 'HEAD');
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-ntrack-response']).toBe('html_200');
    await flush();
    expect(store.events).toHaveLength(0);
  });
});

describe('buildHtmlRedirect', () => {
  it('escapes the destination for HTML and script contexts', () => {
    const page = buildHtmlRedirect('https://brand.com/p?q="><script>alert(1)</script>&x=\'1\'', 'no-referrer');
    expect(page.html).not.toContain('<script>alert(1)</script>');
    expect(page.html).not.toMatch(/href="[^"]*"[^>]*"><script/);
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(page.html)?.[1] ?? '';
    expect(script).not.toContain('<');
  });

  it('refuses non-http destinations', () => {
    expect(() => buildHtmlRedirect('javascript:alert(1)', 'no-referrer')).toThrow();
  });

  it('uses a fresh nonce for every page', () => {
    const a = buildHtmlRedirect('https://brand.com/', 'origin');
    const b = buildHtmlRedirect('https://brand.com/', 'origin');
    expect(a.csp).not.toBe(b.csp);
  });
});
