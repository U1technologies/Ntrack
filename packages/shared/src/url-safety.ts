import { isIP } from 'node:net';

/**
 * Destination and outbound URL safety. Used by:
 *  - the tracker, before every redirect (open-redirect prevention, allowlists)
 *  - the API, when campaigns, landing pages and deep links are saved
 *  - outbound HTTP (postbacks, domain checks, compatibility tester) for SSRF protection
 */

export const MAX_URL_LENGTH = 2048;

export type UrlRejectionReason =
  | 'malformed'
  | 'too_long'
  | 'unsupported_protocol'
  | 'https_required'
  | 'credentials_in_url'
  | 'ip_literal_not_allowed'
  | 'private_address'
  | 'host_not_allowlisted';

export type UrlValidationResult = { ok: true; url: URL } | { ok: false; reason: UrlRejectionReason };

export interface DestinationPolicy {
  /** Exact hostnames or `*.example.com` wildcards (subdomains only; list the apex separately). */
  allowedHosts: string[];
  requireHttps: boolean;
}

export const normalizeHostname = (host: string): string => host.trim().toLowerCase().replace(/\.$/, '');

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/;

export const isValidHostname = (host: string): boolean => HOSTNAME_PATTERN.test(normalizeHostname(host));

/** `*.example.com` matches `a.example.com` and `a.b.example.com`, never `example.com` itself. */
export const hostMatchesAllowlist = (host: string, allowedHosts: string[]): boolean => {
  const target = normalizeHostname(host);
  return allowedHosts.some((entry) => {
    const rule = normalizeHostname(entry);
    if (rule.startsWith('*.')) return target.endsWith(rule.slice(1)) && target.length > rule.length - 1;
    return target === rule;
  });
};

const ipv4ToInt = (ip: string): number => ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;

const IPV4_PRIVATE_CIDRS: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const isPrivateIpv4 = (ip: string): boolean => {
  const value = ipv4ToInt(ip);
  return IPV4_PRIVATE_CIDRS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  });
};

/** True for loopback, link-local, private, CGNAT, documentation, multicast and reserved ranges. */
export const isPrivateAddress = (ip: string): boolean => {
  const family = isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family !== 6) return true;
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
  return (
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower.startsWith('ff') ||
    lower.startsWith('2001:db8')
  );
};

const parseHttpUrl = (raw: string): UrlValidationResult => {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'malformed' };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: 'too_long' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'unsupported_protocol' };
  if (url.username || url.password) return { ok: false, reason: 'credentials_in_url' };
  return { ok: true, url };
};

/**
 * Validates a redirect destination against a campaign's policy. Anything that is not an
 * allowlisted, credential-free http(s) URL on a public hostname is rejected: the tracker never
 * redirects to a destination the campaign has not declared.
 */
export const validateDestinationUrl = (raw: string, policy: DestinationPolicy): UrlValidationResult => {
  const parsed = parseHttpUrl(raw);
  if (!parsed.ok) return parsed;
  const { url } = parsed;
  if (policy.requireHttps && url.protocol !== 'https:') return { ok: false, reason: 'https_required' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return { ok: false, reason: 'ip_literal_not_allowed' };
  if (!hostMatchesAllowlist(host, policy.allowedHosts)) return { ok: false, reason: 'host_not_allowlisted' };
  return { ok: true, url };
};

/**
 * Validates a URL NTrack itself will call (postbacks, webhooks, health checks). Hostname-level
 * check only; callers must also verify resolved addresses with `isPrivateAddress` right before
 * connecting, because DNS can change between validation and request.
 */
export const validateOutboundUrl = (raw: string, { requireHttps = true } = {}): UrlValidationResult => {
  const parsed = parseHttpUrl(raw);
  if (!parsed.ok) return parsed;
  const { url } = parsed;
  if (requireHttps && url.protocol !== 'https:') return { ok: false, reason: 'https_required' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateAddress(host)) return { ok: false, reason: 'private_address' };
  if (['localhost', 'localhost.localdomain'].includes(host.toLowerCase()) || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: 'private_address' };
  }
  return { ok: true, url };
};

export const URL_REJECTION_MESSAGES: Record<UrlRejectionReason, string> = {
  malformed: 'The URL is not valid.',
  too_long: `The URL is longer than ${MAX_URL_LENGTH} characters.`,
  unsupported_protocol: 'Only http and https URLs are supported.',
  https_required: 'The URL must use HTTPS.',
  credentials_in_url: 'URLs must not contain a username or password.',
  ip_literal_not_allowed: 'Destinations must use a hostname, not an IP address.',
  private_address: 'The URL points to a private or reserved network address.',
  host_not_allowlisted: 'The destination host is not in the campaign allowlist.',
};
