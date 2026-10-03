import { describe, expect, it } from 'vitest';
import { DatacenterMatcher, detectBrowser, detectOs, primaryLanguage, targetingMismatch } from '../src';

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 Edg/128.0',
  macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:130.0) Gecko/20100101 Firefox/130.0',
  linuxOpera: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 OPR/113.0',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
};

describe('detectOs and detectBrowser', () => {
  it.each([
    [UA.iphoneSafari, 'ios', 'safari'],
    [UA.androidChrome, 'android', 'chrome'],
    [UA.samsung, 'android', 'samsung'],
    [UA.windowsEdge, 'windows', 'edge'],
    [UA.macFirefox, 'macos', 'firefox'],
    [UA.linuxOpera, 'linux', 'opera'],
    [UA.chromebook, 'chromeos', 'chrome'],
  ])('classifies %s', (ua, os, browser) => {
    expect(detectOs(ua)).toBe(os);
    expect(detectBrowser(ua)).toBe(browser);
  });

  it('returns other for missing user agents', () => {
    expect(detectOs(undefined)).toBe('other');
    expect(detectBrowser('')).toBe('other');
  });
});

describe('primaryLanguage', () => {
  it('picks the highest weighted primary subtag', () => {
    expect(primaryLanguage('en-US,en;q=0.9,hi;q=0.8')).toBe('en');
    expect(primaryLanguage('fr;q=0.4, hi-IN;q=0.9')).toBe('hi');
  });

  it('ignores wildcards and malformed tags', () => {
    expect(primaryLanguage('*')).toBe('');
    expect(primaryLanguage('12-34, de;q=0.5')).toBe('de');
    expect(primaryLanguage(undefined)).toBe('');
  });
});

describe('targetingMismatch', () => {
  const visitor = { os: 'android', browser: 'chrome', language: 'en' } as const;
  it('treats empty lists as no restriction', () => {
    expect(targetingMismatch({ allowedOperatingSystems: [], allowedBrowsers: [], allowedLanguages: [] }, visitor)).toBeNull();
  });
  it('reports the first failing rule', () => {
    expect(targetingMismatch({ allowedOperatingSystems: ['ios'], allowedBrowsers: ['safari'], allowedLanguages: [] }, visitor)).toBe('os_not_allowed');
  });
});

describe('DatacenterMatcher', () => {
  const matcher = new DatacenterMatcher(['3.5.140.0/22', '34.64.0.0/10', '2600:1f00::/24', 'garbage', '10.0.0.0/33']);

  it('matches IPv4 addresses inside published ranges', () => {
    expect(matcher.matches('3.5.140.1')).toBe(true);
    expect(matcher.matches('3.5.143.255')).toBe(true);
    expect(matcher.matches('34.127.255.255')).toBe(true);
  });

  it('does not match addresses just outside the ranges', () => {
    expect(matcher.matches('3.5.144.0')).toBe(false);
    expect(matcher.matches('34.128.0.0')).toBe(false);
    expect(matcher.matches('203.0.113.9')).toBe(false);
  });

  it('matches IPv6 and IPv4-mapped IPv6 addresses', () => {
    expect(matcher.matches('2600:1f00::1')).toBe(true);
    expect(matcher.matches('2600:1fff:ffff::1')).toBe(true);
    expect(matcher.matches('2600:2000::1')).toBe(false);
    expect(matcher.matches('::ffff:3.5.140.9')).toBe(true);
  });

  it('ignores invalid CIDRs and invalid input IPs', () => {
    expect(matcher.size).toBe(3);
    expect(matcher.matches('not-an-ip')).toBe(false);
  });

  it('merges overlapping ranges', () => {
    expect(new DatacenterMatcher(['10.0.0.0/8', '10.1.0.0/16', '11.0.0.0/8']).size).toBe(1);
  });
});
