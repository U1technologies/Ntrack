import type { z } from 'zod';
import type { Prisma } from '@ntrack/db';
import { AppError } from '../../lib/errors';
import { hashPassword } from '../../lib/password';
import { paginated } from '../../lib/response';
import { writeAudit } from '../../services/audit';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';
import type { AssignmentsBody, CreateMemberBody, ListMembersQuery, UpdateMemberBody } from './users.schemas';

const memberInclude = {
  user: { select: { id: true, email: true, name: true, status: true, mfaEnabled: true, lastLoginAt: true } },
  role: { select: { id: true, name: true, slug: true, scope: true } },
  advertiser: { select: { id: true, companyName: true } },
  publisher: { select: { id: true, companyName: true } },
} satisfies Prisma.OrganizationMemberInclude;

export class UsersService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma() {
    return this.deps.prisma;
  }

  private scopeWhere(auth: OrgAuthContext): Prisma.OrganizationMemberWhereInput {
    if (!auth.scope.restricted) return {};
    return {
      OR: [
        { advertiserId: { in: auth.scope.advertiserIds } },
        { publisherId: { in: auth.scope.publisherIds } },
      ],
    };
  }

  async list(auth: OrgAuthContext, query: z.infer<typeof ListMembersQuery>) {
    const where: Prisma.OrganizationMemberWhereInput = {
      organizationId: auth.organizationId,
      ...this.scopeWhere(auth),
      ...(query.roleId ? { roleId: query.roleId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? { user: { OR: [{ email: { contains: query.search, mode: 'insensitive' } }, { name: { contains: query.search, mode: 'insensitive' } }] } }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.organizationMember.findMany({ where, include: memberInclude, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.organizationMember.count({ where }),
    ]);
    const assignments = await this.prisma.managerAssignment.findMany({
      where: { organizationId: auth.organizationId, userId: { in: items.map((m) => m.userId) } },
    });
    const withAssignments = items.map((member) => ({
      ...member,
      assignments: {
        advertiserIds: assignments.filter((a) => a.userId === member.userId && a.advertiserId).map((a) => a.advertiserId!),
        publisherIds: assignments.filter((a) => a.userId === member.userId && a.publisherId).map((a) => a.publisherId!),
      },
    }));
    return paginated(withAssignments, total, query.page, query.pageSize);
  }

  /** Validates the role belongs to the org, is grantable by the actor, and has the link its scope needs. */
  private async resolveRole(auth: OrgAuthContext, roleId: string, advertiserId?: string | null, publisherId?: string | null) {
    const role = await this.prisma.role.findFirst({ where: { id: roleId, organizationId: auth.organizationId }, include: { permissions: true } });
    if (!role) throw AppError.badRequest('Unknown role');
    if (!auth.user.isPlatformAdmin && role.permissions.some((p) => !auth.permissions.has(p.permissionKey))) {
      throw AppError.forbidden('You cannot assign a role with more permissions than your own');
    }
    if (role.scope === 'advertiser' && !advertiserId) throw AppError.badRequest('Advertiser users must be linked to an advertiser');
    if (role.scope === 'publisher' && !publisherId) throw AppError.badRequest('Publisher users must be linked to a publisher');
    if (advertiserId && !(await this.prisma.advertiser.findFirst({ where: { id: advertiserId, organizationId: auth.organizationId } }))) {
      throw AppError.badRequest('Unknown advertiser');
    }
    if (publisherId && !(await this.prisma.publisher.findFirst({ where: { id: publisherId, organizationId: auth.organizationId } }))) {
      throw AppError.badRequest('Unknown publisher');
    }
    return role;
  }

  async create(auth: OrgAuthContext, input: z.infer<typeof CreateMemberBody>, meta: RequestMeta) {
    const role = await this.resolveRole(auth, input.roleId, input.advertiserId, input.publisherId);
    let user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (!user) {
      if (!input.password) throw AppError.badRequest('An initial password is required for a new user');
      user = await this.prisma.user.create({ data: { email: input.email, name: input.name, passwordHash: await hashPassword(input.password) } });
    }
    const member = await this.prisma.organizationMember.create({
      data: {
        organizationId: auth.organizationId,
        userId: user.id,
        roleId: role.id,
        advertiserId: role.scope === 'advertiser' ? input.advertiserId : null,
        publisherId: role.scope === 'publisher' ? input.publisherId : null,
      },
      include: memberInclude,
    });
    await writeAudit(this.prisma, auth, meta, { action: 'member.created', entityType: 'member', entityId: member.id, summary: `${input.email} as ${role.name}`, after: member });
    return member;
  }

  private async findMember(auth: OrgAuthContext, id: string) {
    const member = await this.prisma.organizationMember.findFirst({ where: { id, organizationId: auth.organizationId } });
    if (!member) throw AppError.notFound('User');
    return member;
  }

  async update(auth: OrgAuthContext, id: string, input: z.infer<typeof UpdateMemberBody>, meta: RequestMeta) {
    const before = await this.findMember(auth, id);
    if (before.userId === auth.user.id && (input.roleId || input.status)) throw AppError.forbidden('You cannot change your own role or status');
    const roleId = input.roleId ?? before.roleId;
    const advertiserId = input.advertiserId !== undefined ? input.advertiserId : before.advertiserId;
    const publisherId = input.publisherId !== undefined ? input.publisherId : before.publisherId;
    const role = await this.resolveRole(auth, roleId, advertiserId, publisherId);
    const after = await this.prisma.organizationMember.update({
      where: { id },
      data: {
        roleId,
        status: input.status,
        advertiserId: role.scope === 'advertiser' ? advertiserId : null,
        publisherId: role.scope === 'publisher' ? publisherId : null,
      },
      include: memberInclude,
    });
    await writeAudit(this.prisma, auth, meta, { action: 'member.updated', entityType: 'member', entityId: id, before, after });
    return after;
  }

  async setAssignments(auth: OrgAuthContext, id: string, input: z.infer<typeof AssignmentsBody>, meta: RequestMeta) {
    const member = await this.findMember(auth, id);
    const [advertisers, publishers] = await Promise.all([
      this.prisma.advertiser.count({ where: { id: { in: input.advertiserIds }, organizationId: auth.organizationId } }),
      this.prisma.publisher.count({ where: { id: { in: input.publisherIds }, organizationId: auth.organizationId } }),
    ]);
    if (advertisers !== new Set(input.advertiserIds).size || publishers !== new Set(input.publisherIds).size) {
      throw AppError.badRequest('Some advertisers or publishers do not exist');
    }
    await this.prisma.$transaction([
      this.prisma.managerAssignment.deleteMany({ where: { organizationId: auth.organizationId, userId: member.userId } }),
      this.prisma.managerAssignment.createMany({
        data: [
          ...[...new Set(input.advertiserIds)].map((advertiserId) => ({ organizationId: auth.organizationId, userId: member.userId, advertiserId })),
          ...[...new Set(input.publisherIds)].map((publisherId) => ({ organizationId: auth.organizationId, userId: member.userId, publisherId })),
        ],
      }),
    ]);
    await writeAudit(this.prisma, auth, meta, { action: 'member.assignments_updated', entityType: 'member', entityId: id, after: input });
    return input;
  }

  async resetPassword(auth: OrgAuthContext, id: string, password: string, meta: RequestMeta) {
    const member = await this.findMember(auth, id);
    // Changing a password affects every organization the user belongs to, so only allow it for
    // users who belong to this organization alone (or when the actor is a platform admin).
    const memberships = await this.prisma.organizationMember.count({ where: { userId: member.userId } });
    if (memberships > 1 && !auth.user.isPlatformAdmin) throw AppError.forbidden('This user belongs to other organizations; ask a platform admin to reset it');
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: member.userId }, data: { passwordHash: await hashPassword(password), failedLoginCount: 0, lockedUntil: null } }),
      this.prisma.session.deleteMany({ where: { userId: member.userId } }),
    ]);
    await writeAudit(this.prisma, auth, meta, { action: 'member.password_reset', entityType: 'member', entityId: id });
  }

  async remove(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    const member = await this.findMember(auth, id);
    if (member.userId === auth.user.id) throw AppError.forbidden('You cannot remove yourself');
    await this.prisma.$transaction([
      this.prisma.managerAssignment.deleteMany({ where: { organizationId: auth.organizationId, userId: member.userId } }),
      this.prisma.organizationMember.delete({ where: { id } }),
    ]);
    await writeAudit(this.prisma, auth, meta, { action: 'member.removed', entityType: 'member', entityId: id, before: member });
  }
}
