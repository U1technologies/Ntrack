import { z } from 'zod';
import { generateSecretToken } from '@ntrack/shared';
import { renderPasswordChangedEmail, renderPasswordResetEmail } from '@ntrack/notifications';
import { sha256 } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { hashPassword } from '../../lib/password';
import { consoleUrl, queueAccountEmail } from '../../services/account-email';
import { writeAudit } from '../../services/audit';
import type { AppDeps, RequestMeta } from '../../types';
import { password } from './auth.schemas';

const RESET_MINUTES = 30;
const INVALID_LINK = 'This reset link is invalid or has expired. Request a new one.';

export const ForgotPasswordBody = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
export const ResetPasswordWithTokenBody = z.object({ token: z.string().min(20).max(200), password });

/** Sends the "password changed" notice used by every password change path. */
export const notifyPasswordChanged = (deps: AppDeps, email: string) =>
  queueAccountEmail(deps, email, renderPasswordChangedEmail({ when: new Date().toISOString().slice(0, 16).replace('T', ' ') }), 'account.password_changed').catch((error: unknown) =>
    deps.logger.error({ err: error }, 'failed to queue password changed email')
  );

/**
 * Self-service password reset. The request endpoint answers the same way whether or not the email
 * has an account (no enumeration); links are single use, expire in 30 minutes, and using one signs
 * the user out everywhere.
 */
export class PasswordResetService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma() {
    return this.deps.prisma;
  }

  async request(email: string, meta: RequestMeta): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true, status: true } });
    if (!user || user.status !== 'active') return;
    const token = generateSecretToken(32);
    await this.prisma.$transaction([
      // Only the newest link works.
      this.prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } }),
      this.prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_MINUTES * 60_000), requestedIp: meta.ip },
      }),
    ]);
    await queueAccountEmail(
      this.deps,
      email,
      renderPasswordResetEmail({ url: consoleUrl(this.deps.config, `/reset-password?token=${encodeURIComponent(token)}`), expiresInMinutes: RESET_MINUTES }),
      'account.password_reset'
    );
    await writeAudit(this.prisma, null, meta, { action: 'auth.password_reset_requested', entityType: 'user', entityId: user.id, organizationId: null });
  }

  async reset(input: z.infer<typeof ResetPasswordWithTokenBody>, meta: RequestMeta) {
    const record = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(input.token) }, include: { user: { select: { id: true, email: true, status: true } } } });
    if (!record || record.usedAt || record.expiresAt < new Date() || record.user.status !== 'active') throw new AppError(400, INVALID_LINK, 'invalid_link');
    const passwordHash = await hashPassword(input.password);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
      if (claimed.count !== 1) throw new AppError(400, INVALID_LINK, 'invalid_link');
      await tx.user.update({ where: { id: record.userId }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } });
      await tx.session.deleteMany({ where: { userId: record.userId } });
      await tx.passwordResetToken.updateMany({ where: { userId: record.userId, usedAt: null }, data: { usedAt: new Date() } });
    });
    await writeAudit(this.prisma, null, meta, { action: 'auth.password_reset', entityType: 'user', entityId: record.userId, organizationId: null });
    await notifyPasswordChanged(this.deps, record.user.email);
    return { email: record.user.email };
  }
}
