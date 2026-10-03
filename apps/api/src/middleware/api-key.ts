import type { RequestHandler } from 'express';
import { isIP } from 'node:net';
import { API_KEY_BLOCKED_PATH_PREFIXES, API_KEY_FORBIDDEN_PERMISSIONS, API_KEY_PATTERN, DatacenterMatcher } from '@ntrack/shared';
import { sha256 } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { buildAuthContext } from '../services/auth-context';
import type { ApiRequestLog } from '../services/api-request-log';
import type { AppDeps } from '../types';

/** Whether `ip` matches any allowlist entry (single IPs or CIDR ranges, IPv4 or IPv6). */
export const ipAllowed = (allowlist: string[], ip: string): boolean => {
  if (allowlist.length === 0) return true;
  const normalised = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  return new DatacenterMatcher(allowlist).matches(normalised);
};

const minuteKey = (keyId: string) => `ntrack:apik:${keyId}:${Math.floor(Date.now() / 60_000)}`;
const dayKey = (organizationId: string) => `ntrack:apiq:${organizationId}:${new Date().toISOString().slice(0, 10)}`;

/**
 * Authenticates `Authorization: Bearer ntk_live_…` requests. A key acts as its creator with the
 * intersection of the key's permissions and the creator's current permissions, inside the
 * creator's data scope, so it can never do more than that person can today. Keys are limited per
 * minute and per organization per day, blocked from account-management areas, and every request
 * is logged. Requests without a key fall through to cookie sessions.
 */
export const apiKeyAuth =
  (deps: AppDeps, log: ApiRequestLog): RequestHandler =>
  async (req, res, next) => {
    const header = req.get('authorization');
    if (!header?.toLowerCase().startsWith('bearer ')) return next();
    const secret = header.slice(7).trim();
    if (!API_KEY_PATTERN.test(secret)) throw new AppError(401, 'Invalid API key', 'invalid_api_key');

    const key = await deps.prisma.apiKey.findUnique({ where: { secretHash: sha256(secret) } });
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < new Date())) throw new AppError(401, 'Invalid, revoked or expired API key', 'invalid_api_key');

    // Log from here on, including requests refused below (IP, blocked area, limits).
    const startedAt = performance.now();
    res.on('finish', () => {
      log.record({ organizationId: key.organizationId, apiKeyId: key.id, method: req.method, url: req.originalUrl, status: res.statusCode, latencyMs: performance.now() - startedAt, ip: req.ip ?? '', userAgent: req.get('user-agent') ?? '' });
    });
    if (!ipAllowed(key.allowedIps, req.ip ?? '')) throw new AppError(403, 'This API key is not allowed from this IP address', 'ip_not_allowed');

    const user = await deps.prisma.user.findUnique({ where: { id: key.createdById }, select: { id: true, email: true, name: true, isPlatformAdmin: true, mfaEnabled: true, status: true } });
    if (!user || user.status !== 'active') throw new AppError(401, 'The person who created this API key no longer has access', 'invalid_api_key');
    const context = await buildAuthContext(deps.prisma, { id: `apikey:${key.id}`, mfaVerified: true, activeOrganizationId: key.organizationId, user });
    if (context.organizationId !== key.organizationId) throw new AppError(401, 'The person who created this API key no longer has access', 'invalid_api_key');

    const path = req.path;
    if (API_KEY_BLOCKED_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      throw new AppError(403, 'This part of the API is not available to API keys', 'api_key_forbidden');
    }

    // Per-key per-minute limit and per-organization daily allowance.
    const [perMinute, perDay, settings] = await Promise.all([
      deps.redis.multi().incr(minuteKey(key.id)).expire(minuteKey(key.id), 70).exec(),
      deps.redis.multi().incr(dayKey(key.organizationId)).expire(dayKey(key.organizationId), 2 * 86_400).exec(),
      deps.prisma.organizationSettings.findUnique({ where: { organizationId: key.organizationId }, select: { apiDailyRequestLimit: true } }),
    ]);
    const minuteCount = Number(perMinute?.[0]?.[1] ?? 0);
    const dayCount = Number(perDay?.[0]?.[1] ?? 0);
    const dailyLimit = settings?.apiDailyRequestLimit ?? 100_000;
    res.setHeader('X-RateLimit-Limit', String(key.requestsPerMinute));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, key.requestsPerMinute - minuteCount)));
    if (minuteCount > key.requestsPerMinute) {
      res.setHeader('Retry-After', '60');
      throw new AppError(429, 'Rate limit exceeded for this API key', 'rate_limited');
    }
    if (dayCount > dailyLimit) throw new AppError(429, "Your organization's daily API allowance is used up", 'quota_exceeded');

    const forbidden = new Set<string>(API_KEY_FORBIDDEN_PERMISSIONS);
    const permissions = new Set(key.permissions.filter((p) => context.permissions.has(p) && !forbidden.has(p)));
    req.auth = { ...context, permissions, mfaSetupRequired: false, apiKey: { id: key.id, name: key.name } };

    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) {
      deps.prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date(), lastUsedIp: req.ip ?? '' } }).catch(() => undefined);
    }
    next();
  };
