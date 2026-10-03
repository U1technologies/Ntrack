import { describe, expect, it } from 'vitest';
import { buildHtmlRedirect } from '../../tracker/src/services/html-redirect';
import { htmlNavigationTarget, inspectHtmlNavigation } from '../src/modules/tools/html-navigation';

describe('inspectHtmlNavigation', () => {
  it('reads every navigation path from the tracker\'s own HTML 200 page', () => {
    const destination = 'https://brand.com/offer?aff=01J9Z3QK4T8W2M6N7P5R0S1V2X&s1=a b&x="q"';
    const page = buildHtmlRedirect(destination, 'no-referrer');
    const nav = inspectHtmlNavigation(page.html, 'https://trk.example.com/c/abc');
    const normalized = new URL(destination).toString();
    expect(nav.metaRefreshUrl).toBe(normalized);
    expect(nav.metaRefreshDelay).toBe(0);
    expect(nav.scriptUrl).toBe(normalized);
    expect(nav.linkUrl).toBe(normalized);
    expect(nav.metaReferrer).toBe('no-referrer');
    expect(nav.linkRel).toBe('noreferrer');
    expect(nav.robots).toContain('noindex');
    expect(htmlNavigationTarget(nav)).toBe(normalized);
  });

  it('handles third-party pages: attribute order, quotes, relative URLs and location.href', () => {
    const html = `<html><head><META CONTENT='3; URL="/next?a=1&amp;b=2"' HTTP-EQUIV='Refresh'></head>
      <body><script>window.location.href = 'https://other.example/x';</script></body></html>`;
    const nav = inspectHtmlNavigation(html, 'https://site.example/start');
    expect(nav.metaRefreshUrl).toBe('https://site.example/next?a=1&b=2');
    expect(nav.metaRefreshDelay).toBe(3);
    expect(nav.scriptUrl).toBe('https://other.example/x');
    expect(nav.linkUrl).toBeNull();
  });

  it('ignores javascript: and other non-http targets', () => {
    const nav = inspectHtmlNavigation('<meta http-equiv="refresh" content="0;url=javascript:alert(1)"><a href="javascript:void(0)">x</a>', 'https://a.example/');
    expect(nav.metaRefreshUrl).toBeNull();
    expect(nav.linkUrl).toBeNull();
  });

  it('returns no target for a normal landing page', () => {
    const nav = inspectHtmlNavigation('<html><body><h1>Welcome</h1><a href="/pricing">Pricing</a></body></html>', 'https://brand.com/');
    expect(htmlNavigationTarget(nav)).toBeNull();
  });
});
