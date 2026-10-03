import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * How click IP addresses are stored. Organizations pick one in privacy settings:
 *  - truncated: IPv4 /24, IPv6 /48 (default; enough for geo/fraud aggregation, not identifying)
 *  - hashed:    keyed HMAC of the full address (lets fraud rules match repeats, not reversible)
 *  - none:      nothing stored
 * Full addresses are only ever held in memory while the click is processed.
 */
export type IpStorageMode = 'truncated' | 'hashed' | 'none';

const expandIpv6 = (ip: string): string[] => {
  const [head = '', tail = ''] = ip.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = ip.includes('::') ? 8 - headParts.length - tailParts.length : 0;
  return [...headParts, ...Array(missing).fill('0'), ...tailParts].map((part) => part.padStart(4, '0'));
};

export const truncateIp = (ip: string): string => {
  const family = isIP(ip);
  if (family === 4) return ip.split('.').slice(0, 3).concat('0').join('.');
  if (family === 6) {
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return truncateIp(mapped[1]);
    return `${expandIpv6(ip).slice(0, 3).join(':')}::`;
  }
  return '';
};

export const hashIp = (ip: string, secret: string): string => createHmac('sha256', secret).update(ip).digest('hex').slice(0, 32);

export const storeIp = (ip: string, mode: IpStorageMode, secret: string): string => {
  if (!ip || mode === 'none') return '';
  return mode === 'hashed' ? hashIp(ip, secret) : truncateIp(ip);
};

/** Fingerprint used only for unique-click and duplicate detection keys (never persisted raw). */
export const visitorFingerprint = (ip: string, userAgent: string, secret: string): string =>
  createHmac('sha256', secret).update(`${ip}|${userAgent}`).digest('base64url').slice(0, 22);

/** Stable per organization, different across organizations, not reversible. */
export const organizationVisitorId = (organizationId: string, ip: string, userAgent: string, secret: string): string =>
  createHmac('sha256', secret).update(`${organizationId}|${ip}|${userAgent}`).digest('base64url').slice(0, 22);
