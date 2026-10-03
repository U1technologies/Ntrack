import type { z } from 'zod';
import { runClickReport } from '@ntrack/analytics';
import {
  challengeRecordName,
  challengeRecordValue,
  checkDomainHealth,
  generatePublicId,
  generateSecretToken,
  verifyDomain,
} from '@ntrack/shared';
import { AppError } from '../../lib/errors';
import { analyticsScope } from '../../services/access-scope';
import { writeAudit } from '../../services/audit';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';
import type { CreateDomainBody, UpdateDomainBody } from './domains.schemas';

/** Hostnames under .localhost resolve to the developer machine; they skip DNS checks outside production. */
const isLocalDevHost = (hostname: string) => hostname === 'localhost' || hostname.endsWith('.localhost');

export class DomainsService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma() {
    return this.deps.prisma;
  }

  dnsInstructions(domain: { hostname: string; verificationToken: string }) {
    return {
      ownership: { type: 'TXT', name: challengeRecordName(domain.hostname), value: challengeRecordValue(domain.verificationToken) },
      routing: { type: 'CNAME', name: domain.hostname, value: this.deps.config.TRACKER_CNAME_TARGET },
      notes: [
        'Add both records at your DNS provider, then click Verify.',
        'Apex domains cannot use CNAME; use CNAME flattening or ALIAS records pointing to the same target.',
        'HTTPS certificates are issued automatically once the domain points to NTrack (Cloudflare for SaaS / edge TLS).',
      ],
    };
  }

  async list(auth: OrgAuthContext) {
    const domains = await this.prisma.trackingDomain.findMany({
      where: { organizationId: auth.organizationId },
      include: { advertiser: { select: { id: true, companyName: true } }, _count: { select: { trackingLinks: true, campaigns: true } } },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    return domains.map(({ verificationToken: _t, ...domain }) => domain);
  }

  private async find(auth: OrgAuthContext, id: string) {
    const domain = await this.prisma.trackingDomain.findFirst({ where: { id, organizationId: auth.organizationId } });
    if (!domain) throw AppError.notFound('Tracking domain');
    return domain;
  }

  async get(auth: OrgAuthContext, id: string) {
    const domain = await this.find(auth, id);
    const [healthChecks, counts] = await Promise.all([
      this.prisma.domainHealthCheck.findMany({ where: { domainId: id }, orderBy: { checkedAt: 'desc' }, take: 50 }),
      this.prisma.trackingDomain.findUniqueOrThrow({ where: { id }, select: { _count: { select: { trackingLinks: true, campaigns: true } } } }),
    ]);
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 86_400_000);
    const traffic = await runClickReport(this.deps.clickhouse, {
      scope: analyticsScope(auth),
      from: from.toISOString(),
      to: to.toISOString(),
      timezone: auth.organizationTimezone,
      dimensions: ['date'],
      metrics: ['clicks', 'valid_clicks', 'invalid_clicks', 'avg_latency_ms'],
      filters: { domain: [id] },
      limit: 31,
    }).catch((error) => {
      this.deps.logger.warn({ err: error }, 'domain traffic query failed');
      return [];
    });
    const { verificationToken: _t, ...rest } = domain;
    return { ...rest, ...counts._count, healthChecks, traffic, dns: this.dnsInstructions(domain) };
  }

  async create(auth: OrgAuthContext, input: z.infer<typeof CreateDomainBody>, meta: RequestMeta) {
    if (await this.prisma.trackingDomain.findUnique({ where: { hostname: input.hostname } })) {
      throw AppError.conflict('This hostname is already registered with NTrack');
    }
    if (input.advertiserId && !(await this.prisma.advertiser.findFirst({ where: { id: input.advertiserId, organizationId: auth.organizationId } }))) {
      throw AppError.badRequest('Unknown advertiser');
    }
    const domain = await this.prisma.$transaction(async (tx) => {
      if (input.isDefault) await tx.trackingDomain.updateMany({ where: { organizationId: auth.organizationId }, data: { isDefault: false } });
      const created = await tx.trackingDomain.create({
        data: {
          ...input,
          publicId: generatePublicId('dom'),
          organizationId: auth.organizationId,
          verificationToken: generateSecretToken(18),
        },
      });
      await writeAudit(tx, auth, meta, { action: 'domain.created', entityType: 'tracking_domain', entityId: created.id, summary: created.hostname, after: created });
      return created;
    });
    await this.deps.publisher.publishDomain(domain.id);
    return { ...domain, verificationToken: undefined, dns: this.dnsInstructions(domain) };
  }

  async update(auth: OrgAuthContext, id: string, input: z.infer<typeof UpdateDomainBody>, meta: RequestMeta) {
    const before = await this.find(auth, id);
    if (input.status === 'active' && !before.verifiedAt) throw AppError.badRequest('Verify the domain before activating it');
    const after = await this.prisma.$transaction(async (tx) => {
      if (input.isDefault) await tx.trackingDomain.updateMany({ where: { organizationId: auth.organizationId }, data: { isDefault: false } });
      const updated = await tx.trackingDomain.update({
        where: { id },
        data: { ...input, domainExpiresAt: input.domainExpiresAt === undefined ? undefined : input.domainExpiresAt ? new Date(input.domainExpiresAt) : null },
      });
      await writeAudit(tx, auth, meta, { action: 'domain.updated', entityType: 'tracking_domain', entityId: id, summary: updated.hostname, before, after: updated });
      return updated;
    });
    await this.deps.publisher.publishDomain(id);
    return { ...after, verificationToken: undefined };
  }

  async verify(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    const domain = await this.find(auth, id);
    const devBypass = this.deps.config.NODE_ENV !== 'production' && isLocalDevHost(domain.hostname);
    const result = devBypass
      ? { ownershipVerified: true, routingVerified: true, foundTxt: [], foundCname: [], error: null }
      : await verifyDomain(domain.hostname, domain.verificationToken, this.deps.config.TRACKER_CNAME_TARGET);
    const verified = result.ownershipVerified && result.routingVerified;
    const updated = await this.prisma.trackingDomain.update({
      where: { id },
      data: verified
        ? { status: domain.status === 'inactive' ? 'inactive' : 'active', verifiedAt: domain.verifiedAt ?? new Date(), lastError: null }
        : { status: domain.verifiedAt ? domain.status : 'pending_verification', lastError: 'DNS records not found yet' },
    });
    await writeAudit(this.prisma, auth, meta, {
      action: verified ? 'domain.verified' : 'domain.verification_failed',
      entityType: 'tracking_domain',
      entityId: id,
      summary: domain.hostname,
      after: result,
    });
    await this.deps.publisher.publishDomain(id);
    return { verified, ...result, status: updated.status, devBypass, dns: this.dnsInstructions(domain) };
  }

  async checkNow(auth: OrgAuthContext, id: string) {
    const domain = await this.find(auth, id);
    const health = await checkDomainHealth(domain.hostname);
    const ok = health.dnsOk && health.httpsOk;
    await this.prisma.$transaction([
      this.prisma.domainHealthCheck.create({
        data: { domainId: id, dnsOk: health.dnsOk, httpsOk: health.httpsOk, statusCode: health.statusCode, latencyMs: health.latencyMs, sslExpiresAt: health.sslExpiresAt, error: health.error },
      }),
      this.prisma.trackingDomain.update({
        where: { id },
        data: {
          lastCheckedAt: new Date(),
          lastCheckOk: ok,
          lastLatencyMs: health.latencyMs,
          lastError: health.error,
          sslExpiresAt: health.sslExpiresAt ?? undefined,
          sslStatus: health.sslExpiresAt ? (health.sslExpiresAt > new Date() ? 'valid' : 'expired') : undefined,
        },
      }),
    ]);
    return health;
  }

  async remove(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    const domain = await this.find(auth, id);
    const links = await this.prisma.trackingLink.count({ where: { domainId: id } });
    if (links > 0) throw AppError.conflict('Links use this domain. Deactivate it instead so existing links keep their history.');
    await this.prisma.trackingDomain.delete({ where: { id } });
    await this.deps.publisher.removeDomain(domain.hostname);
    await writeAudit(this.prisma, auth, meta, { action: 'domain.deleted', entityType: 'tracking_domain', entityId: id, summary: domain.hostname, before: domain });
  }
}
