import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import { Prisma, type DataRequest } from '@ntrack/db';
import { csvLine } from '../../lib/tabular';
import type { FileStore } from '../../services/file-store';
import type { AppDeps } from '../../types';

/**
 * Builds a privacy export as a zip of JSON and CSV files. Large tables are streamed in pages so
 * memory stays flat. Secrets (password and token hashes, encrypted credentials) are never exported;
 * partner tax and payment details are decrypted only in that partner's own export.
 */

type Row = Record<string, unknown>;
type Entry = { name: string; content: string | Readable };

const PAGE = 2_000;
/** Field names that are never exported (credentials, token hashes, encrypted blobs). */
const SECRET_FIELD = /(hash|encrypted|secret|token)$/i;

const redact = (row: Row): Row => Object.fromEntries(Object.entries(row).filter(([key]) => !SECRET_FIELD.test(key)));

const toPlain = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));

const json = (value: unknown) => `${JSON.stringify(toPlain(value), null, 2)}\n`;

/** Pages through a findMany with an id cursor. */
async function* pages(findMany: (args: { take: number; skip?: number; cursor?: { id: string }; orderBy: { id: 'asc' } }) => Promise<Row[]>) {
  let cursor: string | undefined;
  for (;;) {
    const rows = await findMany({ take: PAGE, orderBy: { id: 'asc' }, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) });
    if (rows.length === 0) return;
    yield rows;
    cursor = rows[rows.length - 1]!.id as string;
    if (rows.length < PAGE) return;
  }
}

/** Streams rows as CSV; columns come from the first row. Counts rows into `counter`. */
const csvStream = (source: AsyncGenerator<Row[]>, counter: { rows: number }) =>
  Readable.from(
    (async function* () {
      let columns: string[] | null = null;
      for await (const batch of source) {
        for (const raw of batch) {
          const row = redact(toPlain(raw) as Row);
          if (!columns) {
            columns = Object.keys(row);
            yield csvLine(columns);
          }
          yield csvLine(columns.map((c) => (typeof row[c] === 'object' && row[c] !== null ? JSON.stringify(row[c]) : row[c])));
          counter.rows += 1;
        }
      }
      if (!columns) yield 'no rows\n';
    })()
  );

const readme = (request: DataRequest, files: string[]) =>
  [
    'NTrack data export',
    '==================',
    `Subject: ${request.subjectType} ${request.subjectLabel || request.subjectId}`,
    `Generated: ${new Date().toISOString()}`,
    `Request ID: ${request.id}`,
    '',
    'Files:',
    ...files.map((file) => `- ${file}`),
    '',
    'Amounts are decimal strings in the record currency. Times are UTC (ISO 8601).',
    'Credentials, token hashes and encrypted secrets are never included.',
    'Click-level analytics are not included; export them from Analytics for any period you need.',
    '',
  ].join('\n');

export class ExportBuilder {
  constructor(
    private readonly deps: AppDeps,
    private readonly files: FileStore
  ) {}

  private get prisma() {
    return this.deps.prisma;
  }

  private decrypt(value: string | null) {
    if (!value) return null;
    try {
      return this.deps.secretBox.decryptJson<unknown>(value);
    } catch {
      return { error: 'could not be decrypted' };
    }
  }

  /**
   * A person's own export covers everything about them. An export created by an organization admin
   * is limited to that organization: no memberships, activity or sessions from anywhere else.
   */
  private async userEntries(request: DataRequest): Promise<Entry[]> {
    const userId = request.subjectId;
    const org = request.selfService ? {} : { organizationId: request.organizationId };
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, name: true, status: true, mfaEnabled: true, isPlatformAdmin: true, lastLoginAt: true, createdAt: true, updatedAt: true },
    });
    const [memberships, sessions, notifications, preferences, reports, invitations] = await Promise.all([
      this.prisma.organizationMember.findMany({
        where: { userId, ...org },
        select: { status: true, createdAt: true, organization: { select: { name: true } }, role: { select: { name: true } }, advertiser: { select: { companyName: true } }, publisher: { select: { companyName: true } } },
      }),
      // Sessions are account-wide, so they only appear in the person's own export.
      request.selfService ? this.prisma.session.findMany({ where: { userId }, select: { createdAt: true, lastSeenAt: true, expiresAt: true, ip: true, userAgent: true } }) : Promise.resolve([]),
      this.prisma.notification.findMany({ where: { userId, ...org }, select: { type: true, title: true, body: true, readAt: true, createdAt: true } }),
      this.prisma.notificationPreference.findMany({ where: { userId, ...org }, select: { type: true, inApp: true, email: true } }),
      this.prisma.scheduledReport.findMany({ where: { userId, ...org } }),
      this.prisma.invitation.findMany({ where: { email: user.email, ...org }, select: { createdAt: true, expiresAt: true, acceptedAt: true, revokedAt: true, organization: { select: { name: true } }, role: { select: { name: true } } } }),
    ]);
    // Activity by this person: what they did, not the before/after contents (which describe other records).
    const activity = { rows: 0 };
    const auditRows = pages((args) =>
      this.prisma.auditLog.findMany({
        ...args,
        where: { actorUserId: userId, ...org },
        select: { id: true, createdAt: true, action: true, entityType: true, entityId: true, summary: true, ip: true, userAgent: true, organizationId: true },
      }) as Promise<Row[]>
    );
    return [
      { name: 'profile.json', content: json(user) },
      { name: 'memberships.json', content: json(memberships) },
      { name: 'sessions.json', content: json(sessions) },
      { name: 'notifications.json', content: json(notifications) },
      { name: 'notification-preferences.json', content: json(preferences) },
      { name: 'scheduled-reports.json', content: json(reports.map((r) => redact(r as Row))) },
      { name: 'invitations.json', content: json(invitations) },
      { name: 'activity.csv', content: csvStream(auditRows, activity) },
    ];
  }

  private async publisherEntries(request: DataRequest): Promise<Entry[]> {
    const where = { organizationId: request.organizationId, publisherId: request.subjectId };
    const publisher = await this.prisma.publisher.findFirstOrThrow({ where: { id: request.subjectId, organizationId: request.organizationId } });
    const { taxInfoEncrypted, paymentDetailsEncrypted, ...profile } = publisher;
    const [members, access, links, payouts, payments, postbacks, fraud] = await Promise.all([
      this.prisma.organizationMember.findMany({ where, select: { createdAt: true, status: true, user: { select: { email: true, name: true } }, role: { select: { name: true } } } }),
      this.prisma.campaignPublisher.findMany({ where, include: { campaign: { select: { publicId: true, name: true } } } }),
      this.prisma.trackingLink.findMany({ where }),
      this.prisma.publisherPayout.findMany({ where }),
      this.prisma.payment.findMany({ where }),
      this.prisma.postback.findMany({ where }),
      this.prisma.fraudEvent.findMany({ where, select: { createdAt: true, type: true, severity: true, reason: true, status: true, appealNote: true, campaignId: true, conversionId: true } }),
    ]);
    const conversions = { rows: 0 };
    // Publisher view: payout, never the advertiser's revenue.
    const conversionRows = pages((args) =>
      this.prisma.conversion.findMany({
        ...args,
        where,
        select: { id: true, publicId: true, campaignId: true, clickId: true, event: true, transactionId: true, status: true, currency: true, payout: true, saleAmount: true, sub1: true, sub2: true, sub3: true, sub4: true, sub5: true, country: true, deviceType: true, clickedAt: true, convertedAt: true },
      }) as Promise<Row[]>
    );
    return [
      { name: 'profile.json', content: json({ ...profile, taxInfo: this.decrypt(taxInfoEncrypted), paymentDetails: this.decrypt(paymentDetailsEncrypted) }) },
      { name: 'users.json', content: json(members) },
      { name: 'campaign-access.json', content: json(access) },
      { name: 'tracking-links.json', content: json(links) },
      { name: 'payouts.json', content: json(payouts) },
      { name: 'payments.json', content: json(payments) },
      { name: 'postbacks.json', content: json(postbacks.map((p) => redact(p as Row))) },
      { name: 'fraud-events.json', content: json(fraud) },
      { name: 'conversions.csv', content: csvStream(conversionRows, conversions) },
    ];
  }

  private async advertiserEntries(request: DataRequest): Promise<Entry[]> {
    const where = { organizationId: request.organizationId, advertiserId: request.subjectId };
    const advertiser = await this.prisma.advertiser.findFirstOrThrow({ where: { id: request.subjectId, organizationId: request.organizationId } });
    const [members, campaigns, invoices, payments] = await Promise.all([
      this.prisma.organizationMember.findMany({ where, select: { createdAt: true, status: true, user: { select: { email: true, name: true } }, role: { select: { name: true } } } }),
      this.prisma.campaign.findMany({ where, include: { landingPages: true } }),
      this.prisma.invoice.findMany({ where, include: { lines: true } }),
      this.prisma.payment.findMany({ where }),
    ]);
    const conversions = { rows: 0 };
    // Advertiser view: revenue they pay, never publisher payouts.
    const conversionRows = pages((args) =>
      this.prisma.conversion.findMany({
        ...args,
        where,
        select: { id: true, publicId: true, campaignId: true, clickId: true, event: true, transactionId: true, status: true, currency: true, revenue: true, saleAmount: true, country: true, deviceType: true, clickedAt: true, convertedAt: true },
      }) as Promise<Row[]>
    );
    return [
      { name: 'profile.json', content: json(redact(advertiser as Row)) },
      { name: 'users.json', content: json(members) },
      { name: 'campaigns.json', content: json(campaigns) },
      { name: 'invoices.json', content: json(invoices) },
      { name: 'payments.json', content: json(payments) },
      { name: 'conversions.csv', content: csvStream(conversionRows, conversions) },
    ];
  }

  /**
   * Whole-organization export (portability): every organization-scoped table, found from the
   * schema so new tables are included automatically. Encrypted fields stay out of bulk exports.
   */
  private organizationEntries(request: DataRequest): Entry[] {
    const delegates = this.prisma as unknown as Record<string, { findMany: (args: unknown) => Promise<Row[]> }>;
    const scoped = Prisma.dmmf.datamodel.models.filter((model) => model.fields.some((field) => field.name === 'organizationId') && model.fields.some((field) => field.name === 'id'));
    const entries: Entry[] = scoped.map((model) => {
      const delegate = delegates[model.name.charAt(0).toLowerCase() + model.name.slice(1)]!;
      return { name: `tables/${model.dbName ?? model.name}.csv`, content: csvStream(pages((args) => delegate.findMany({ ...args, where: { organizationId: request.organizationId } })), { rows: 0 }) };
    });
    const users = pages((args) =>
      this.prisma.organizationMember.findMany({
        ...args,
        where: { organizationId: request.organizationId },
        select: { id: true, status: true, createdAt: true, user: { select: { email: true, name: true } }, role: { select: { name: true, slug: true } } },
      }) as Promise<Row[]>
    );
    entries.push({ name: 'members.csv', content: csvStream(users, { rows: 0 }) });
    return entries;
  }

  async build(request: DataRequest): Promise<{ fileKey: string; size: number; files: string[] }> {
    const entries =
      request.subjectType === 'user'
        ? await this.userEntries(request)
        : request.subjectType === 'publisher'
          ? await this.publisherEntries(request)
          : request.subjectType === 'advertiser'
            ? await this.advertiserEntries(request)
            : this.organizationEntries(request);
    const files = entries.map((e) => e.name);
    const fileKey = `${request.organizationId}/${request.id}.zip`;
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const output = await this.files.writer(fileKey);
    const done = pipeline(archive, output);
    archive.append(readme(request, files), { name: 'README.txt' });
    for (const entry of entries) archive.append(entry.content, { name: entry.name });
    await archive.finalize();
    await done;
    return { fileKey, size: await this.files.size(fileKey), files };
  }
}
