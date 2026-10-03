import { generateSecretToken } from '@ntrack/shared';
import { sha256 } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../../lib/password';
import { generateTotpSecret, totpQrCode, verifyTotp } from '../../lib/totp';
import { writeAudit } from '../../services/audit';
import type { AppDeps, AuthContext, RequestMeta } from '../../types';
import { notifyPasswordChanged } from './password-reset.service';

const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MINUTES = 15;
const GENERIC_LOGIN_ERROR = 'Invalid email or password';

export class AuthService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma() {
    return this.deps.prisma;
  }

  async login(email: string, password: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash || user.status !== 'active') {
      await burnPasswordCheck(password);
      throw AppError.unauthorized(GENERIC_LOGIN_ERROR);
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError(423, 'Too many failed attempts. Try again in a few minutes.', 'locked');
    }
    if (!(await verifyPassword(user.passwordHash, password))) {
      const failed = user.failedLoginCount + 1;
      await this.prisma.user.update({
        where: { id: user.id },
        data: failed >= MAX_FAILED_LOGINS ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60_000) } : { failedLoginCount: failed },
      });
      await writeAudit(this.prisma, null, meta, { action: 'auth.login_failed', entityType: 'user', entityId: user.id, organizationId: null, summary: email });
      throw AppError.unauthorized(GENERIC_LOGIN_ERROR);
    }

    const activeOrganizationId = await this.defaultOrganizationId(user.id, user.isPlatformAdmin);
    const token = generateSecretToken();
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: sha256(token),
        activeOrganizationId,
        mfaVerified: !user.mfaEnabled,
        ip: meta.ip,
        userAgent: meta.userAgent,
        expiresAt: new Date(Date.now() + this.deps.config.SESSION_TTL_HOURS * 3_600_000),
      },
    });
    await this.prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
    await writeAudit(this.prisma, null, meta, { action: 'auth.login', entityType: 'user', entityId: user.id, organizationId: activeOrganizationId, summary: email });
    return { token, expiresAt: session.expiresAt, mfaRequired: user.mfaEnabled };
  }

  private async defaultOrganizationId(userId: string, isPlatformAdmin: boolean): Promise<string | null> {
    const membership = await this.prisma.organizationMember.findFirst({ where: { userId, status: 'active' }, orderBy: { createdAt: 'asc' } });
    if (membership) return membership.organizationId;
    if (!isPlatformAdmin) return null;
    const organization = await this.prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
    return organization?.id ?? null;
  }

  async verifyMfa(auth: AuthContext, code: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
    const secret = user.mfaSecretEncrypted ? this.deps.secretBox.decrypt(user.mfaSecretEncrypted) : null;
    if (!user.mfaEnabled || !secret || !verifyTotp(secret, code)) {
      await writeAudit(this.prisma, auth, meta, { action: 'auth.mfa_failed', entityType: 'user', entityId: user.id });
      throw AppError.unauthorized('Invalid verification code');
    }
    await this.prisma.session.update({ where: { id: auth.sessionId }, data: { mfaVerified: true } });
  }

  async logout(auth: AuthContext) {
    await this.prisma.session.deleteMany({ where: { id: auth.sessionId } });
  }

  async me(auth: AuthContext) {
    const organizations = auth.user.isPlatformAdmin
      ? await this.prisma.organization.findMany({ select: { id: true, name: true, slug: true, publicId: true }, orderBy: { name: 'asc' } })
      : (
          await this.prisma.organizationMember.findMany({
            where: { userId: auth.user.id, status: 'active', organization: { status: 'active' } },
            select: { organization: { select: { id: true, name: true, slug: true, publicId: true } } },
          })
        ).map((m) => m.organization);
    return {
      user: auth.user,
      mfaVerified: auth.mfaVerified,
      mfaSetupRequired: auth.mfaSetupRequired,
      organizationId: auth.organizationId,
      organizationTimezone: auth.organizationTimezone,
      organizations,
      role: auth.role,
      scope: { type: auth.scope.type, restricted: auth.scope.restricted, advertiserIds: auth.scope.advertiserIds, publisherIds: auth.scope.publisherIds },
      permissions: [...auth.permissions].sort(),
    };
  }

  async switchOrganization(auth: AuthContext, organizationId: string, meta: RequestMeta) {
    const allowed = auth.user.isPlatformAdmin
      ? await this.prisma.organization.findUnique({ where: { id: organizationId } })
      : await this.prisma.organizationMember.findFirst({ where: { organizationId, userId: auth.user.id, status: 'active' } });
    if (!allowed) throw AppError.notFound('Organization');
    await this.prisma.session.update({ where: { id: auth.sessionId }, data: { activeOrganizationId: organizationId } });
    await writeAudit(this.prisma, auth, meta, { action: 'auth.switch_organization', entityType: 'organization', entityId: organizationId, organizationId });
  }

  async startMfaSetup(auth: AuthContext) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
    if (user.mfaEnabled) throw AppError.conflict('Two-factor authentication is already enabled');
    const secret = generateTotpSecret();
    await this.prisma.user.update({ where: { id: user.id }, data: { mfaSecretEncrypted: this.deps.secretBox.encrypt(secret) } });
    return { secret, qrCodeDataUrl: await totpQrCode(user.email, secret) };
  }

  async enableMfa(auth: AuthContext, code: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
    const secret = user.mfaSecretEncrypted ? this.deps.secretBox.decrypt(user.mfaSecretEncrypted) : null;
    if (!secret) throw AppError.badRequest('Start two-factor setup first');
    if (!verifyTotp(secret, code)) throw AppError.badRequest('Invalid verification code');
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: true } }),
      this.prisma.session.update({ where: { id: auth.sessionId }, data: { mfaVerified: true } }),
      this.prisma.session.deleteMany({ where: { userId: user.id, id: { not: auth.sessionId } } }),
    ]);
    await writeAudit(this.prisma, auth, meta, { action: 'auth.mfa_enabled', entityType: 'user', entityId: user.id });
  }

  async disableMfa(auth: AuthContext, password: string, code: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
    const secret = user.mfaSecretEncrypted ? this.deps.secretBox.decrypt(user.mfaSecretEncrypted) : null;
    if (!user.mfaEnabled || !secret) throw AppError.badRequest('Two-factor authentication is not enabled');
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, password)) || !verifyTotp(secret, code)) {
      throw AppError.unauthorized('Password or verification code is incorrect');
    }
    if (auth.mfaSetupRequired || (auth.organizationId && (await this.prisma.organizationSettings.findUnique({ where: { organizationId: auth.organizationId } }))?.mfaRequired)) {
      throw AppError.forbidden('Your organization requires two-factor authentication');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: false, mfaSecretEncrypted: null } });
    await writeAudit(this.prisma, auth, meta, { action: 'auth.mfa_disabled', entityType: 'user', entityId: user.id });
  }

  async changePassword(auth: AuthContext, currentPassword: string, newPassword: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, currentPassword))) throw AppError.badRequest('Current password is incorrect');
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword) } }),
      this.prisma.session.deleteMany({ where: { userId: user.id, id: { not: auth.sessionId } } }),
    ]);
    await writeAudit(this.prisma, auth, meta, { action: 'auth.password_changed', entityType: 'user', entityId: user.id });
    await notifyPasswordChanged(this.deps, user.email);
  }
}
