import { z } from 'zod';
import type { ApiKey } from '@ntrack/db';
import { API_KEY_FORBIDDEN_PERMISSIONS, API_KEY_PREFIX, DatacenterMatcher, generateSecretToken, isPermissionKey } from '@ntrack/shared';
import { sha256 } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { writeAudit } from '../../services/audit';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';

const ipEntry = z
  .string()
  .trim()
  .max(64)
  .refine((value) => new DatacenterMatcher([value]).size === 1, 'Use an IP address or a CIDR range such as 203.0.113.0/24');

export const CreateApiKeyBody = z.object({
  name: z.string().trim().min(2).max(80),
  permissions: z.array(z.string()).min(1, 'Choose at least one permission').max(100),
  expiresInDays: z.number().int().min(1).max(730).nullish(),
  allowedIps: z.array(ipEntry).max(50).default([]),
  requestsPerMinute: z.number().int().min(10).max(600).default(120),
});

export const ApiLogsQuery = z.object({
  keyId: z.string().uuid().optional(),
  status: z.enum(['success', 'client_error', 'server_error']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const present = (key: ApiKey, names: Map<string, string>) => {
  const { secretHash: _hidden, ...rest } = key;
  return { ...rest, createdByName: names.get(key.createdById) ?? null, status: key.revokedAt ? 'revoked' : key.expiresAt && key.expiresAt < new Date() ? 'expired' : 'active' };
};

/**
 * API key management. People with integrations.manage create keys for themselves; organization-wide
 * managers can see and revoke every key, partners only their own. Keys can never hold more than
 * the creator's permissions, nor account-management permissions.
 */
export class ApiKeysService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma() {
    return this.deps.prisma;
  }

  /** Restricted (partner/managed) users only see keys they created. */
  private visibleWhere(auth: OrgAuthContext) {
    return { organizationId: auth.organizationId, ...(auth.scope.restricted ? { createdById: auth.user.id } : {}) };
  }

  private async names(keys: ApiKey[]) {
    const people = await this.prisma.user.findMany({ where: { id: { in: [...new Set(keys.map((k) => k.createdById))] } }, select: { id: true, name: true } });
    return new Map(people.map((p) => [p.id, p.name]));
  }

  /** Permissions the caller may put on a key. */
  grantable(auth: OrgAuthContext): string[] {
    const forbidden = new Set<string>(API_KEY_FORBIDDEN_PERMISSIONS);
    return [...auth.permissions].filter((p) => !forbidden.has(p)).sort();
  }

  async list(auth: OrgAuthContext) {
    const keys = await this.prisma.apiKey.findMany({ where: this.visibleWhere(auth), orderBy: { createdAt: 'desc' } });
    const names = await this.names(keys);
    return keys.map((key) => present(key, names));
  }

  private validatePermissions(auth: OrgAuthContext, requested: string[]) {
    const allowed = new Set(this.grantable(auth));
    const unique = [...new Set(requested)];
    const invalid = unique.filter((p) => !isPermissionKey(p) || !allowed.has(p));
    if (invalid.length) throw AppError.badRequest(`These permissions cannot be given to this key: ${invalid.join(', ')}`, { fields: [{ path: 'permissions', message: 'Not allowed' }] });
    return unique;
  }

  private async issue(auth: OrgAuthContext, input: { name: string; permissions: string[]; expiresAt: Date | null; allowedIps: string[]; requestsPerMinute: number }) {
    const secret = `${API_KEY_PREFIX}${generateSecretToken(32)}`;
    const key = await this.prisma.apiKey.create({
      data: {
        organizationId: auth.organizationId,
        name: input.name,
        prefix: secret.slice(0, API_KEY_PREFIX.length + 6),
        secretHash: sha256(secret),
        permissions: input.permissions,
        allowedIps: input.allowedIps,
        requestsPerMinute: input.requestsPerMinute,
        expiresAt: input.expiresAt,
        createdById: auth.user.id,
      },
    });
    return { key, secret };
  }

  async create(auth: OrgAuthContext, input: z.infer<typeof CreateApiKeyBody>, meta: RequestMeta) {
    const permissions = this.validatePermissions(auth, input.permissions);
    const { key, secret } = await this.issue(auth, {
      name: input.name,
      permissions,
      expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
      allowedIps: [...new Set(input.allowedIps)],
      requestsPerMinute: input.requestsPerMinute,
    });
    await writeAudit(this.prisma, auth, meta, { action: 'api_key.created', entityType: 'api_key', entityId: key.id, summary: `${key.name} (${key.prefix}…) ${permissions.join(', ')}` });
    // The secret is returned once and never stored.
    return { key: present(key, new Map([[auth.user.id, auth.user.name]])), secret };
  }

  private async findManageable(auth: OrgAuthContext, id: string) {
    const key = await this.prisma.apiKey.findFirst({ where: { id, ...this.visibleWhere(auth) } });
    if (!key) throw AppError.notFound('API key');
    if (key.revokedAt) throw AppError.conflict('This key is already revoked');
    return key;
  }

  async revoke(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    const key = await this.findManageable(auth, id);
    await this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    await writeAudit(this.prisma, auth, meta, { action: 'api_key.revoked', entityType: 'api_key', entityId: id, summary: `${key.name} (${key.prefix}…)` });
    return { id };
  }

  /** Replaces a key with a new secret and the same settings; the old secret stops working at once. */
  async rotate(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    const old = await this.findManageable(auth, id);
    if (old.createdById !== auth.user.id) throw AppError.forbidden('Only the person who created a key can rotate it; others can revoke it');
    const permissions = this.validatePermissions(auth, old.permissions);
    const { key, secret } = await this.issue(auth, { name: old.name, permissions, expiresAt: old.expiresAt, allowedIps: old.allowedIps, requestsPerMinute: old.requestsPerMinute });
    await this.prisma.apiKey.update({ where: { id: old.id }, data: { revokedAt: new Date(), replacedById: key.id } });
    await writeAudit(this.prisma, auth, meta, { action: 'api_key.rotated', entityType: 'api_key', entityId: key.id, summary: `${old.prefix}… replaced by ${key.prefix}…` });
    return { key: present(key, new Map([[auth.user.id, auth.user.name]])), secret };
  }

  private async keyIds(auth: OrgAuthContext, keyId?: string): Promise<string[] | null> {
    if (keyId) {
      const key = await this.prisma.apiKey.findFirst({ where: { id: keyId, ...this.visibleWhere(auth) }, select: { id: true } });
      if (!key) throw AppError.notFound('API key');
      return [key.id];
    }
    if (!auth.scope.restricted) return null;
    return (await this.prisma.apiKey.findMany({ where: this.visibleWhere(auth), select: { id: true } })).map((k) => k.id);
  }

  async logs(auth: OrgAuthContext, query: z.infer<typeof ApiLogsQuery>) {
    const ids = await this.keyIds(auth, query.keyId);
    if (ids && ids.length === 0) return { items: [], pagination: { page: query.page, pageSize: query.pageSize, total: 0, totalPages: 1 } };
    const status = query.status === 'success' ? 'status < 400' : query.status === 'client_error' ? 'status >= 400 AND status < 500' : query.status === 'server_error' ? 'status >= 500' : '1';
    const where = `organization_id = {org:UUID} ${ids ? 'AND api_key_id IN {ids:Array(UUID)}' : ''} AND ${status}`;
    const params = { org: auth.organizationId, ...(ids ? { ids } : {}) };
    const [rows, count] = await Promise.all([
      this.deps.clickhouse
        .query({
          // Output aliases must not reuse column names: ClickHouse would apply WHERE to the alias.
          query: `SELECT formatDateTime(ts, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS logged_at, toString(api_key_id) AS key_id, method, path, status, latency_ms, ip, user_agent
                  FROM api_requests WHERE ${where} ORDER BY api_requests.ts DESC LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
          query_params: { ...params, limit: query.pageSize, offset: (query.page - 1) * query.pageSize },
          format: 'JSONEachRow',
        })
        .then((r) => r.json<Record<string, unknown>>()),
      this.deps.clickhouse.query({ query: `SELECT count() AS total FROM api_requests WHERE ${where}`, query_params: params, format: 'JSONEachRow' }).then((r) => r.json<{ total: string }>()),
    ]);
    const total = Number(count[0]?.total ?? 0);
    return { items: rows, pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) } };
  }

  /** Requests per day for the last 30 days, plus today's use of the daily allowance. */
  async usage(auth: OrgAuthContext) {
    const ids = await this.keyIds(auth);
    const settings = await this.prisma.organizationSettings.findUnique({ where: { organizationId: auth.organizationId }, select: { apiDailyRequestLimit: true } });
    const today = Number((await this.deps.redis.get(`ntrack:apiq:${auth.organizationId}:${new Date().toISOString().slice(0, 10)}`)) ?? 0);
    if (ids && ids.length === 0) return { days: [], dailyLimit: settings?.apiDailyRequestLimit ?? 100_000, usedToday: today };
    const days = await this.deps.clickhouse
      .query({
        query: `SELECT toString(toDate(ts)) AS day, count() AS requests, countIf(status >= 400) AS errors, round(avg(latency_ms), 1) AS avg_latency_ms
                FROM api_requests WHERE organization_id = {org:UUID} ${ids ? 'AND api_key_id IN {ids:Array(UUID)}' : ''} AND ts >= now() - INTERVAL 30 DAY
                GROUP BY day ORDER BY day`,
        query_params: { org: auth.organizationId, ...(ids ? { ids } : {}) },
        format: 'JSONEachRow',
      })
      .then((r) => r.json<{ day: string; requests: string; errors: string; avg_latency_ms: number }>());
    return {
      days: days.map((d) => ({ day: d.day, requests: Number(d.requests), errors: Number(d.errors), avgLatencyMs: d.avg_latency_ms })),
      dailyLimit: settings?.apiDailyRequestLimit ?? 100_000,
      usedToday: today,
    };
  }
}
