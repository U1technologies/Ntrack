import type { FastifyRequest } from 'fastify';

/**
 * Request facts the tracker needs. Proxy/geo headers are only trusted when TRUST_PROXY is on
 * (i.e. the tracker sits behind Cloudflare or our load balancer); otherwise anyone could spoof
 * their country or IP with a header.
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

const firstValues = (query: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!query || typeof query !== 'object') return out;
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') out[key] = first;
  }
  return out;
};

export const extractRequestFacts = (request: FastifyRequest, trustProxy: boolean): RequestFacts => {
  const host = (request.hostname || '').split(':')[0]?.toLowerCase() ?? '';
  const ip = (trustProxy && header(request, 'cf-connecting-ip')) || request.ip;
  const country = trustProxy ? header(request, 'cf-ipcountry').toUpperCase() : '';
  return {
    host,
    ip,
    userAgent: header(request, 'user-agent').slice(0, 512),
    referrer: header(request, 'referer'),
    acceptLanguage: header(request, 'accept-language').slice(0, 256),
    country: country === 'XX' || country === 'T1' ? '' : country,
    region: trustProxy ? header(request, 'cf-region-code') : '',
    city: trustProxy ? header(request, 'cf-ipcity') : '',
    query: firstValues(request.query),
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
