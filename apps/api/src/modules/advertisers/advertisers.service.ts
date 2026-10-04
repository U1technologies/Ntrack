import type { z } from 'zod';
import type { Prisma } from '@ntrack/db';
import { generatePublicId, generateSecretToken } from '@ntrack/shared';
import { sha256 } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { paginated } from '../../lib/response';
import { advertiserWhere } from '../../services/access-scope';
import { TOKEN_PLACEHOLDER, TRACKING_SETUP_NOTES, buildTrackingSnippets, canRevealPostbackToken } from '../../services/tracking-snippets';
import { writeAudit } from '../../services/audit';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';
import type { AdvertiserBody, ListAdvertisersQuery, UpdateAdvertiserBody } from './advertisers.schemas';

export class AdvertisersService {
  constructor(private readonly deps: AppDeps) {}

  /** Token material never leaves the API except through trackingSetup / rotatePostbackToken. */
  private strip<T extends { postbackTokenEncrypted?: string | null; postbackTokenHash?: string | null }>(advertiser: T) {
    const { postbackTokenEncrypted, postbackTokenHash: _hash, ...rest } = advertiser;
    return { ...rest, hasPostbackToken: Boolean(postbackTokenEncrypted) };
  }

  async list(auth: OrgAuthContext, query: z.infer<typeof ListAdvertisersQuery>) {
    const where: Prisma.AdvertiserWhereInput = {
      organizationId: auth.organizationId,
      ...advertiserWhere(auth.scope),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { companyName: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
              { publicId: query.search },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.deps.prisma.advertiser.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { _count: { select: { campaigns: true } } },
      }),
      this.deps.prisma.advertiser.count({ where }),
    ]);
    return paginated(items.map((a) => this.strip(a)), total, query.page, query.pageSize);
  }

  async get(auth: OrgAuthContext, id: string) {
    const advertiser = await this.deps.prisma.advertiser.findFirst({
      where: { id, organizationId: auth.organizationId, ...advertiserWhere(auth.scope) },
      include: { _count: { select: { campaigns: true } }, campaigns: { select: { id: true, name: true, status: true, publicId: true }, orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    if (!advertiser) throw AppError.notFound('Advertiser');
    return this.strip(advertiser);
  }

  async create(auth: OrgAuthContext, input: z.infer<typeof AdvertiserBody>, meta: RequestMeta) {
    const advertiser = await this.deps.prisma.advertiser.create({
      data: { ...input, publicId: generatePublicId('adv'), organizationId: auth.organizationId },
    });
    await writeAudit(this.deps.prisma, auth, meta, { action: 'advertiser.created', entityType: 'advertiser', entityId: advertiser.id, summary: advertiser.companyName, after: advertiser });
    await this.deps.publisher.publishAdvertiser(advertiser.id);
    return this.strip(advertiser);
  }

  async update(auth: OrgAuthContext, id: string, input: z.infer<typeof UpdateAdvertiserBody>, meta: RequestMeta) {
    const before = await this.get(auth, id);
    const after = await this.deps.prisma.advertiser.update({ where: { id }, data: input });
    await writeAudit(this.deps.prisma, auth, meta, { action: 'advertiser.updated', entityType: 'advertiser', entityId: id, summary: after.companyName, before, after });
    await this.deps.publisher.publishAdvertiser(id);
    return this.strip(after);
  }

  /** Issues a new S2S postback token. The previous token stops working immediately. */
  async rotatePostbackToken(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    await this.get(auth, id);
    const token = generateSecretToken(24);
    await this.deps.prisma.advertiser.update({
      where: { id },
      data: { postbackTokenEncrypted: this.deps.secretBox.encrypt(token), postbackTokenHash: sha256(token) },
    });
    await this.deps.publisher.publishAdvertiser(id);
    await writeAudit(this.deps.prisma, auth, meta, { action: 'advertiser.postback_token_rotated', entityType: 'advertiser', entityId: id });
    return this.trackingSetup(auth, id);
  }

  /** Everything an advertiser needs to send conversions: S2S URL, pixel and JavaScript tag. */
  async trackingSetup(auth: OrgAuthContext, id: string) {
    await this.get(auth, id);
    const advertiser = await this.deps.prisma.advertiser.findUniqueOrThrow({ where: { id } });
    const domain =
      (await this.deps.prisma.trackingDomain.findFirst({ where: { organizationId: auth.organizationId, status: 'active', advertiserId: id } })) ??
      (await this.deps.prisma.trackingDomain.findFirst({ where: { organizationId: auth.organizationId, status: 'active' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] }));
    const stored = advertiser.postbackTokenEncrypted ? this.deps.secretBox.decrypt(advertiser.postbackTokenEncrypted) : null;
    // View-only roles (e.g. analysts) see the setup without the secret token.
    const token = stored && !canRevealPostbackToken(auth.permissions) ? TOKEN_PLACEHOLDER : stored;
    const base = domain ? `https://${domain.hostname}` : null;
    const snippets = buildTrackingSnippets(base, token);
    return {
      domain: domain?.hostname ?? null,
      token,
      s2sUrl: snippets.server_postback,
      pixelHtml: snippets.image_pixel,
      iframeHtml: snippets.iframe_pixel,
      javascript: snippets.js_tag,
      notes: [...TRACKING_SETUP_NOTES, 'Server-to-server postbacks are the most reliable method; pixels depend on the browser and cookie settings.'],
    };
  }

  async remove(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    const advertiser = await this.get(auth, id);
    if (advertiser._count.campaigns > 0) throw AppError.conflict('Archive or delete this advertiser\'s campaigns first, or suspend the advertiser instead');
    await this.deps.prisma.advertiser.delete({ where: { id } });
    await writeAudit(this.deps.prisma, auth, meta, { action: 'advertiser.deleted', entityType: 'advertiser', entityId: id, summary: advertiser.companyName, before: advertiser });
  }
}
