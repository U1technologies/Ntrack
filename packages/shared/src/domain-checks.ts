import { promises as dns } from 'node:dns';
import { isPrivateAddress, normalizeHostname } from './url-safety';
import { safeRequest } from './safe-http';

/**
 * Tracking domain ownership verification and health checks.
 *
 * Ownership: the customer publishes TXT `_ntrack-challenge.<hostname>` = `ntrack-verify=<token>`.
 * Routing:   <hostname> must CNAME to the tracker target (or resolve to the same addresses), or
 *            answer https://<hostname>/.well-known/ntrack from the tracker. The last case covers
 *            a website that forwards its tracking paths to NTrack (nextagmedia.com/click on Vercel).
 * Health:    HTTPS GET https://<hostname>/.well-known/ntrack must answer from the tracker.
 */

export const challengeRecordName = (hostname: string) => `_ntrack-challenge.${normalizeHostname(hostname)}`;
export const challengeRecordValue = (token: string) => `ntrack-verify=${token}`;

export interface DomainVerificationResult {
  ownershipVerified: boolean;
  routingVerified: boolean;
  foundTxt: string[];
  foundCname: string[];
  error: string | null;
}

const safeResolve = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

const isTrackerAnswer = (status: number, body: string) => status === 200 && body.includes('ntrack-tracker');

/** True when https://<host>/.well-known/ntrack is answered by the tracker (directly or forwarded). */
const answersFromTracker = async (host: string): Promise<boolean> => {
  try {
    const response = await safeRequest(`https://${host}/.well-known/ntrack`, { timeoutMs: 8000 });
    return isTrackerAnswer(response.status, response.body);
  } catch {
    return false;
  }
};

export const verifyDomain = async (hostname: string, token: string, cnameTarget: string): Promise<DomainVerificationResult> => {
  const host = normalizeHostname(hostname);
  const target = normalizeHostname(cnameTarget);
  const txtRecords = (await safeResolve(() => dns.resolveTxt(challengeRecordName(host)), [] as string[][])).map((parts) => parts.join(''));
  const cnames = (await safeResolve(() => dns.resolveCname(host), [] as string[])).map(normalizeHostname);

  let routingVerified = cnames.includes(target);
  if (!routingVerified) {
    // Apex domains cannot CNAME; accept matching A records (e.g. CNAME flattening at Cloudflare).
    const [hostIps, targetIps] = await Promise.all([
      safeResolve(() => dns.resolve4(host), [] as string[]),
      safeResolve(() => dns.resolve4(target), [] as string[]),
    ]);
    routingVerified = hostIps.length > 0 && hostIps.every((ip) => targetIps.includes(ip));
  }
  if (!routingVerified) routingVerified = await answersFromTracker(host);

  return {
    ownershipVerified: txtRecords.includes(challengeRecordValue(token)),
    routingVerified,
    foundTxt: txtRecords,
    foundCname: cnames,
    error: null,
  };
};

export interface DomainHealthResult {
  dnsOk: boolean;
  httpsOk: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  sslExpiresAt: Date | null;
  error: string | null;
}

export const checkDomainHealth = async (hostname: string, timeoutMs = 8000): Promise<DomainHealthResult> => {
  const host = normalizeHostname(hostname);
  const addresses = await safeResolve(() => dns.resolve4(host), [] as string[]);
  const dnsOk = addresses.length > 0 && addresses.every((ip) => !isPrivateAddress(ip));
  if (!dnsOk) {
    return { dnsOk: false, httpsOk: false, statusCode: null, latencyMs: null, sslExpiresAt: null, error: addresses.length ? 'Resolves to a private address' : 'No A records found' };
  }
  try {
    const response = await safeRequest(`https://${host}/.well-known/ntrack`, { timeoutMs });
    const servedByTracker = isTrackerAnswer(response.status, response.body);
    return {
      dnsOk,
      httpsOk: servedByTracker,
      statusCode: response.status,
      latencyMs: response.durationMs,
      sslExpiresAt: response.certificateValidTo,
      error: servedByTracker ? null : `Unexpected response (HTTP ${response.status}); the domain may not point to the NTrack tracker`,
    };
  } catch (error) {
    return { dnsOk, httpsOk: false, statusCode: null, latencyMs: null, sslExpiresAt: null, error: (error as Error).message };
  }
};

/**
 * Registration expiry via RDAP. Uses the last two labels as the registrable domain, which is
 * wrong for multi-part public suffixes (e.g. co.uk); those return null and can be set manually.
 */
export const lookupDomainExpiry = async (hostname: string): Promise<Date | null> => {
  const labels = normalizeHostname(hostname).split('.');
  if (labels.length < 2) return null;
  const registrable = labels.slice(-2).join('.');
  try {
    const response = await safeRequest(`https://rdap.org/domain/${registrable}`, { timeoutMs: 8000, maxBodyBytes: 256 * 1024 });
    if (response.status === 302 || response.status === 301) {
      const location = response.headers.location;
      if (!location) return null;
      const followed = await safeRequest(location, { timeoutMs: 8000, maxBodyBytes: 256 * 1024 });
      return parseRdapExpiry(followed.body);
    }
    return response.status === 200 ? parseRdapExpiry(response.body) : null;
  } catch {
    return null;
  }
};

const parseRdapExpiry = (body: string): Date | null => {
  try {
    const data = JSON.parse(body) as { events?: Array<{ eventAction: string; eventDate: string }> };
    const expiry = data.events?.find((event) => event.eventAction === 'expiration');
    return expiry ? new Date(expiry.eventDate) : null;
  } catch {
    return null;
  }
};
