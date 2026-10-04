import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

/**
 * Request facts the tracker needs. Visitor IP, country and host normally come from the
 * connection. They are taken from headers only when the sender is trusted:
 * - a request forwarded by the website (Vercel) carrying the shared TRACKER_PROXY_SECRET, which
 *   sends the visitor's details as x-ntrack-* headers, or
 * - TRUST_PROXY=true when the tracker sits directly behind Cloudflare (cf-* headers).
 * Anything else could spoof its country or IP with a header, so those headers are ignored.
 */
export interface RequestFacts {
  host: string;
  ip: string;
  userAgent: string;
  referrer: string;
  acceptLanguage: string;
  country: string;
  region: string;
  city: string;
  query: Record<string, string>;
}

const header = (request: FastifyRequest, name: string): string => {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? '';
};

export interface ProxyTrust {
  trustProxy: boolean;
  /** Shared with the website; '' disables forwarded headers. */
  proxySecret: string;
}

export const PROXY_HEADERS = {
  secret: 'x-ntrack-proxy-secret',
  clientIp: 'x-ntrack-client-ip',
  country: 'x-ntrack-country',
  region: 'x-ntrack-region',
  city: 'x-ntrack-city',
  host: 'x-ntrack-host',
} as const;

const HOSTNAME_PATTERN = /^[a-z0-9.-]{1,253}$/;

const sameSecret = (given: string, expected: string): boolean => {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** True when the request came through the website's forwarding with the right secret. */
export const isForwardedByWebsite = (request: FastifyRequest, trust: ProxyTrust): boolean =>
  sameSecret(header(request, PROXY_HEADERS.secret), trust.proxySecret);

const decode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Public hostname the visitor used (e.g. nextagmedia.com), not the tracker's own origin name. */
export const visitorHost = (request: FastifyRequest, trust: ProxyTrust): string => {
  if (isForwardedByWebsite(request, trust)) {
    const forwarded = header(request, PROXY_HEADERS.host).split(':')[0]?.trim().toLowerCase() ?? '';
    if (HOSTNAME_PATTERN.test(forwarded)) return forwarded;
  }
  return (request.hostname || '').split(':')[0]?.toLowerCase() ?? '';
};

const firstValues = (query: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!query || typeof query !== 'object') return out;
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') out[key] = first;
  }
  return out;
};

export const extractRequestFacts = (request: FastifyRequest, trust: ProxyTrust): RequestFacts => {
  const host = visitorHost(request, trust);
  const base = {
    host,
    userAgent: header(request, 'user-agent').slice(0, 512),
    referrer: header(request, 'referer'),
    acceptLanguage: header(request, 'accept-language').slice(0, 256),
    query: firstValues(request.query),
  };
  if (isForwardedByWebsite(request, trust)) {
    const forwardedIp = header(request, PROXY_HEADERS.clientIp).trim();
    const country = header(request, PROXY_HEADERS.country).trim().toUpperCase();
    return {
      ...base,
      ip: isIP(forwardedIp) ? forwardedIp : request.ip,
      country: /^[A-Z]{2}$/.test(country) ? country : '',
      region: decode(header(request, PROXY_HEADERS.region)).slice(0, 64),
      city: decode(header(request, PROXY_HEADERS.city)).slice(0, 128),
    };
  }
  const trustProxy = trust.trustProxy;
  const ip = (trustProxy && header(request, 'cf-connecting-ip')) || request.ip;
  const country = trustProxy ? header(request, 'cf-ipcountry').toUpperCase() : '';
  return {
    ...base,
    ip,
    country: country === 'XX' || country === 'T1' ? '' : country,
    region: trustProxy ? header(request, 'cf-region-code') : '',
    city: trustProxy ? header(request, 'cf-ipcity') : '',
  };
};

/** Referrers are stored without query strings or fragments, which commonly carry personal data. */
export const sanitizeReferrer = (referrer: string): { url: string; domain: string } => {
  if (!referrer) return { url: '', domain: '' };
  try {
    const parsed = new URL(referrer);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { url: '', domain: '' };
    return { url: `${parsed.origin}${parsed.pathname}`.slice(0, 512), domain: parsed.hostname.toLowerCase() };
  } catch {
    return { url: '', domain: '' };
  }
};
