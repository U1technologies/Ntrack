import type { DataRequest } from '@ntrack/db';
import { AppError } from '../../lib/errors';
import type { AppDeps } from '../../types';

/**
 * Executes an approved erasure. Personal data is replaced with neutral values; records needed for
 * accounting, tax and fraud history (conversions, ledger, invoices, payouts, audit trail) are kept
 * and keep pointing at the same IDs. Issued invoices are unaffected because they carry a frozen
 * billing snapshot. Nothing is deleted from the database.
 */

export interface ErasureSummary {
  subject: string;
  clearedFields: string[];
  actions: string[];
  kept: string[];
}

const KEPT_FINANCIAL = ['conversions', 'ledger entries', 'invoices (with their billing snapshot)', 'payments', 'payouts', 'audit trail'];

export class ErasureExecutor {
  constructor(private readonly deps: AppDeps) {}

  private get prisma() {
    return this.deps.prisma;
  }

  async run(request: DataRequest): Promise<ErasureSummary> {
    switch (request.subjectType) {
      case 'user':
        return this.eraseUser(request);
      case 'publisher':
        return this.erasePublisher(request);
      case 'advertiser':
        return this.eraseAdvertiser(request);
      default:
        throw AppError.badRequest('Erasing a whole organization is not supported yet');
    }
  }

  private async eraseUser(request: DataRequest): Promise<ErasureSummary> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: request.subjectId } });
    if (user.isPlatformAdmin) throw AppError.forbidden('Platform administrators cannot be erased through an organization request');
    const placeholderEmail = `erased-${user.id}@erased.invalid`;
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { email: placeholderEmail, name: 'Erased user', passwordHash: null, mfaEnabled: false, mfaSecretEncrypted: null, status: 'disabled', failedLoginCount: 0, lockedUntil: null },
      }),
      this.prisma.session.deleteMany({ where: { userId: user.id } }),
      this.prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } }),
      this.prisma.organizationMember.updateMany({ where: { userId: user.id }, data: { status: 'disabled' } }),
      this.prisma.invitation.updateMany({ where: { email: user.email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.prisma.invitation.updateMany({ where: { email: user.email }, data: { email: placeholderEmail, name: '' } }),
      this.prisma.auditLog.updateMany({ where: { actorUserId: user.id }, data: { actorEmail: null } }),
      // Audit entries keep the event but lose the email wherever it was written into the text.
      this.prisma.$executeRaw`
        UPDATE audit_logs
        SET summary = replace(summary, ${user.email}, '[erased]'),
            before = CASE WHEN before IS NULL THEN NULL ELSE replace(before::text, ${user.email}, '[erased]')::jsonb END,
            after = CASE WHEN after IS NULL THEN NULL ELSE replace(after::text, ${user.email}, '[erased]')::jsonb END
        WHERE summary LIKE ${'%' + user.email + '%'} OR before::text LIKE ${'%' + user.email + '%'} OR after::text LIKE ${'%' + user.email + '%'}`,
      this.prisma.scheduledReport.updateMany({ where: { userId: user.id }, data: { active: false } }),
    ]);
    return {
      subject: `user ${user.id}`,
      clearedFields: ['email', 'name', 'password', 'two-factor secret', 'email in audit entries (actor, summaries, details) and invitations'],
      actions: ['signed out everywhere', 'account disabled in every organization', 'pending invitations revoked', 'scheduled reports paused'],
      kept: ['membership records (disabled)', 'audit trail (without email)', 'activity linked to the anonymous user ID'],
    };
  }

  private async erasePublisher(request: DataRequest): Promise<ErasureSummary> {
    const publisher = await this.prisma.publisher.findFirstOrThrow({ where: { id: request.subjectId, organizationId: request.organizationId } });
    await this.prisma.publisher.update({
      where: { id: publisher.id },
      data: {
        companyName: `Erased publisher ${publisher.publicId}`,
        contactName: '',
        email: '',
        phone: '',
        website: '',
        address: '',
        taxInfoEncrypted: null,
        paymentDetailsEncrypted: null,
        monthlyTraffic: '',
        notes: '',
        status: 'suspended',
      },
    });
    // Suspension must reach the tracker so the publisher's links stop being paid.
    await this.deps.publisher.publishLinksWhere({ publisherId: publisher.id });
    const linkedUsers = await this.prisma.organizationMember.count({ where: { organizationId: request.organizationId, publisherId: publisher.id } });
    return {
      subject: `publisher ${publisher.publicId}`,
      clearedFields: ['company name', 'contact name', 'email', 'phone', 'website', 'address', 'tax details', 'payment details', 'traffic description', 'notes'],
      actions: ['publisher suspended (links stop being paid)', ...(linkedUsers ? [`${linkedUsers} linked user account(s) not changed: erase them with separate user requests`] : [])],
      kept: [...KEPT_FINANCIAL, 'tracking links and click statistics (no personal data)'],
    };
  }

  private async eraseAdvertiser(request: DataRequest): Promise<ErasureSummary> {
    const advertiser = await this.prisma.advertiser.findFirstOrThrow({ where: { id: request.subjectId, organizationId: request.organizationId } });
    await this.prisma.advertiser.update({
      where: { id: advertiser.id },
      data: { companyName: `Erased advertiser ${advertiser.publicId}`, contactName: '', email: '', phone: '', website: '', address: '', taxId: '', notes: '', status: 'suspended' },
    });
    const linkedUsers = await this.prisma.organizationMember.count({ where: { organizationId: request.organizationId, advertiserId: advertiser.id } });
    return {
      subject: `advertiser ${advertiser.publicId}`,
      clearedFields: ['company name', 'contact name', 'email', 'phone', 'website', 'address', 'tax ID', 'notes'],
      actions: ['advertiser suspended', ...(linkedUsers ? [`${linkedUsers} linked user account(s) not changed: erase them with separate user requests`] : [])],
      kept: [...KEPT_FINANCIAL, 'campaigns'],
    };
  }
}
