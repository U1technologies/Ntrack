import { z } from 'zod';
import type { Prisma } from '@ntrack/db';
import { generateSecretToken } from '@ntrack/shared';
import { renderInvitationEmail } from '@ntrack/notifications';
import { sha256 } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { hashPassword, verifyPassword } from '../../lib/password';
import { consoleUrl, emailConfigured, queueAccountEmail } from '../../services/account-email';
import { writeAudit } from '../../services/audit';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';
import { password } from '../auth/auth.schemas';
import { UsersService } from './users.service';

const INVITE_DAYS = 7;

export const InviteBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().max(120).default(''),
  roleId: z.string().uuid(),
  advertiserId: z.string().uuid().nullish(),
  publisherId: z.string().uuid().nullish(),
});

export const InvitationTokenBody = z.object({ token: z.string().min(20).max(200) });

export const AcceptInvitationBody = InvitationTokenBody.extend({
  name: z.string().trim().min(1).max(120),
  /** New users choose a password; existing NTrack users confirm with their current password. */
  password: z.string().min(1).max(128),
});

const INVALID_LINK = 'This invitation link is invalid or has expired. Ask your administrator to send a new one.';

const present = (invitation: Prisma.InvitationGetPayload<{ include: { role: { select: { id: true; name: true } } } }>) => {
  const { tokenHash: _hidden, ...rest } = invitation;
  return { ...rest, expired: invitation.expiresAt < new Date() };
};

/**
 * Email invitations. The membership is created only when the invitee accepts, so a pending invite
 * never grants access; revoking keeps the record for the audit trail.
 */
export class InvitationsService {
  private readonly users: UsersService;

  constructor(private readonly deps: AppDeps) {
    this.users = new UsersService(deps);
  }

  private get prisma() {
    return this.deps.prisma;
  }

  private scopeWhere(auth: OrgAuthContext): Prisma.InvitationWhereInput {
    if (!auth.scope.restricted) return {};
    return { OR: [{ advertiserId: { in: auth.scope.advertiserIds } }, { publisherId: { in: auth.scope.publisherIds } }] };
  }

  async list(auth: OrgAuthContext) {
    const items = await this.prisma.invitation.findMany({
      where: { AND: [{ organizationId: auth.organizationId, acceptedAt: null, revokedAt: null }, this.scopeWhere(auth)] },
      include: { role: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return items.map(present);
  }

  private async issue(auth: OrgAuthContext, invitationId: string | null, data: Omit<Prisma.InvitationUncheckedCreateInput, 'tokenHash' | 'expiresAt' | 'organizationId'>) {
    const token = generateSecretToken(32);
    const fields = { tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) };
    const invitation = invitationId
      ? await this.prisma.invitation.update({ where: { id: invitationId }, data: fields, include: { role: { select: { id: true, name: true } } } })
      : await this.prisma.invitation.create({ data: { ...data, ...fields, organizationId: auth.organizationId }, include: { role: { select: { id: true, name: true } } } });
    const url = consoleUrl(this.deps.config, `/accept-invite?token=${encodeURIComponent(token)}`);
    const organization = await this.prisma.organization.findUniqueOrThrow({ where: { id: auth.organizationId }, select: { name: true } });
    await queueAccountEmail(
      this.deps,
      invitation.email,
      renderInvitationEmail({ organizationName: organization.name, inviterName: auth.user.name, roleName: invitation.role.name, url, expiresInDays: INVITE_DAYS }),
      'account.invitation'
    );
    // The link is returned once so an admin can share it while email is not configured.
    return { invitation: present(invitation), inviteUrl: url, emailSent: emailConfigured(this.deps.config) };
  }

  async create(auth: OrgAuthContext, input: z.infer<typeof InviteBody>, meta: RequestMeta) {
    const role = await this.users.resolveRole(auth, input.roleId, input.advertiserId, input.publisherId);
    const existingUser = await this.prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
    if (existingUser && (await this.prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: auth.organizationId, userId: existingUser.id } } }))) {
      throw AppError.conflict('This person is already a member of the organization');
    }
    // A new invitation replaces any pending one for the same email (old links stop working).
    await this.prisma.invitation.updateMany({
      where: { organizationId: auth.organizationId, email: input.email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const result = await this.issue(auth, null, {
      email: input.email,
      name: input.name,
      roleId: role.id,
      advertiserId: role.scope === 'advertiser' ? (input.advertiserId ?? null) : null,
      publisherId: role.scope === 'publisher' ? (input.publisherId ?? null) : null,
      invitedById: auth.user.id,
    });
    await writeAudit(this.prisma, auth, meta, { action: 'invitation.created', entityType: 'invitation', entityId: result.invitation.id, summary: `${input.email} as ${role.name}` });
    return result;
  }

  private async findPending(auth: OrgAuthContext, id: string) {
    const invitation = await this.prisma.invitation.findFirst({ where: { AND: [{ id, organizationId: auth.organizationId, acceptedAt: null, revokedAt: null }, this.scopeWhere(auth)] } });
    if (!invitation) throw AppError.notFound('Invitation');
    return invitation;
  }

  async resend(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    const invitation = await this.findPending(auth, id);
    const result = await this.issue(auth, invitation.id, invitation);
    await writeAudit(this.prisma, auth, meta, { action: 'invitation.resent', entityType: 'invitation', entityId: id, summary: invitation.email });
    return result;
  }

  async revoke(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    const invitation = await this.findPending(auth, id);
    await this.prisma.invitation.update({ where: { id }, data: { revokedAt: new Date() } });
    await writeAudit(this.prisma, auth, meta, { action: 'invitation.revoked', entityType: 'invitation', entityId: id, summary: invitation.email });
    return { id };
  }

  // ─── Public (token holder) ───────────────────────────────────────────────

  private async findValid(token: string) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: sha256(token) },
      include: { organization: { select: { name: true, status: true } }, role: { select: { name: true } } },
    });
    if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt < new Date() || invitation.organization.status !== 'active') {
      throw new AppError(404, INVALID_LINK, 'invalid_link');
    }
    return invitation;
  }

  async lookup(token: string) {
    const invitation = await this.findValid(token);
    const user = await this.prisma.user.findUnique({ where: { email: invitation.email }, select: { passwordHash: true } });
    return {
      organizationName: invitation.organization.name,
      email: invitation.email,
      name: invitation.name,
      roleName: invitation.role.name,
      expiresAt: invitation.expiresAt,
      /** Existing NTrack users confirm with their current password instead of choosing one. */
      existingAccount: Boolean(user?.passwordHash),
    };
  }

  async accept(input: z.infer<typeof AcceptInvitationBody>, meta: RequestMeta) {
    const invitation = await this.findValid(input.token);
    let user = await this.prisma.user.findUnique({ where: { email: invitation.email } });
    if (user?.status === 'disabled') throw AppError.forbidden('This account is disabled. Contact your administrator.');

    let passwordHash: string | null = null;
    if (user?.passwordHash) {
      if (!(await verifyPassword(user.passwordHash, input.password))) throw AppError.badRequest('Enter your current NTrack password to accept', { fields: [{ path: 'password', message: 'Incorrect password' }] });
    } else {
      const strength = password.safeParse(input.password);
      if (!strength.success) throw AppError.badRequest('Choose a stronger password', { fields: [{ path: 'password', message: strength.error.issues[0]?.message ?? 'Too weak' }] });
      passwordHash = await hashPassword(input.password);
    }

    const membership = await this.prisma.$transaction(async (tx) => {
      // Claim the invitation atomically so a link cannot be used twice in parallel.
      const claimed = await tx.invitation.updateMany({ where: { id: invitation.id, acceptedAt: null, revokedAt: null }, data: { acceptedAt: new Date() } });
      if (claimed.count !== 1) throw new AppError(404, INVALID_LINK, 'invalid_link');
      if (!user) {
        user = await tx.user.create({ data: { email: invitation.email, name: input.name, passwordHash, status: 'active' } });
      } else if (passwordHash) {
        user = await tx.user.update({ where: { id: user.id }, data: { passwordHash, name: user.name || input.name, status: 'active' } });
      }
      await tx.invitation.update({ where: { id: invitation.id }, data: { acceptedUserId: user.id } });
      const existing = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: invitation.organizationId, userId: user.id } } });
      if (existing) return existing;
      return tx.organizationMember.create({
        data: {
          organizationId: invitation.organizationId,
          userId: user.id,
          roleId: invitation.roleId,
          advertiserId: invitation.advertiserId,
          publisherId: invitation.publisherId,
        },
      });
    });
    await writeAudit(this.prisma, null, meta, {
      action: 'invitation.accepted',
      entityType: 'member',
      entityId: membership.id,
      organizationId: invitation.organizationId,
      summary: invitation.email,
    });
    // Accepting never signs the user in: they sign in normally, which keeps MFA in the loop.
    return { email: invitation.email };
  }
}
