import type { z } from 'zod';
import type { Prisma } from '@ntrack/db';
import { generatePublicId, generateSecretToken } from '@ntrack/shared';
import { sha256 } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { paginated } from '../../lib/response';
import { advertiserWhere } from '../../services/access-scope';
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
    const token = advertiser.postbackTokenEncrypted ? this.deps.secretBox.decrypt(advertiser.postbackTokenEncrypted) : null;
    const base = domain ? `https://${domain.hostname}` : null;
    return {
      domain: domain?.hostname ?? null,
      token,
      s2sUrl: base && token ? `${base}/pb?click_id={click_id}&token=${token}&event=sale&txn_id={order_id}&amount={order_total}&currency=USD` : null,
      pixelHtml: base ? `<img src="${base}/px?event=sale&txn_id={order_id}&amount={order_total}" width="1" height="1" alt="" style="display:none" referrerpolicy="no-referrer">` : null,
      javascript: base
        ? `<script src="${base}/js/ntrack.js" async></script>\n<script>\n  // On the thank-you page, after the script loads:\n  window.ntrack && window.ntrack.convert({ event: 'sale', txn_id: 'ORDER_ID', amount: '49.90', currency: 'USD' });\n</script>`
        : null,
      notes: [
        'Pass the NTrack click ID to your site: add {click_id} to the landing page URL (e.g. ?aff_click={click_id}) and store it with the order.',
        'Server-to-server postbacks are the most reliable method; pixels depend on the browser and cookie settings.',
        'Send a unique txn_id per order so retries and duplicate postbacks are ignored.',
      ],
    };
  }

  async remove(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    const advertiser = await this.get(auth, id);
    if (advertiser._count.campaigns > 0) throw AppError.conflict('Archive or delete this advertiser\'s campaigns first, or suspend the advertiser instead');
    await this.deps.prisma.advertiser.delete({ where: { id } });
    await writeAudit(this.deps.prisma, auth, meta, { action: 'advertiser.deleted', entityType: 'advertiser', entityId: id, summary: advertiser.companyName, before: advertiser });
  }
}
