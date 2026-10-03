import type { z } from 'zod';
import { ALL_PERMISSIONS, PERMISSION_GROUPS } from '@ntrack/shared';
import { AppError } from '../../lib/errors';
import { writeAudit } from '../../services/audit';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';
import type { CreateRoleBody, UpdateRoleBody } from './roles.schemas';

const slugify = (name: string) =>
  `custom-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)}`;

export class RolesService {
  constructor(private readonly deps: AppDeps) {}

  catalogue() {
    return Object.entries(PERMISSION_GROUPS).map(([module, group]) => ({
      module,
      label: group.label,
      permissions: ALL_PERMISSIONS.filter((p) => p.module === module).map((p) => ({ key: p.key, label: p.label })),
    }));
  }

  async list(auth: OrgAuthContext) {
    const roles = await this.deps.prisma.role.findMany({
      where: { organizationId: auth.organizationId },
      include: { permissions: { select: { permissionKey: true } }, _count: { select: { members: true } } },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
    return roles.map(({ permissions, _count, ...role }) => ({ ...role, permissions: permissions.map((p) => p.permissionKey), memberCount: _count.members }));
  }

  /** Prevents privilege escalation: you can only grant permissions you hold yourself. */
  private assertGrantable(auth: OrgAuthContext, permissions: string[]) {
    if (auth.user.isPlatformAdmin) return;
    const missing = permissions.filter((key) => !auth.permissions.has(key));
    if (missing.length) throw AppError.forbidden(`You cannot grant permissions you do not have: ${missing.join(', ')}`);
  }

  async create(auth: OrgAuthContext, input: z.infer<typeof CreateRoleBody>, meta: RequestMeta) {
    this.assertGrantable(auth, input.permissions);
    const role = await this.deps.prisma.$transaction(async (tx) => {
      const created = await tx.role.create({
        data: { organizationId: auth.organizationId, slug: slugify(input.name), name: input.name, description: input.description, scope: input.scope },
      });
      await tx.rolePermission.createMany({ data: [...new Set(input.permissions)].map((permissionKey) => ({ roleId: created.id, permissionKey })) });
      await writeAudit(tx, auth, meta, { action: 'role.created', entityType: 'role', entityId: created.id, after: { ...created, permissions: input.permissions } });
      return created;
    });
    return role;
  }

  async update(auth: OrgAuthContext, id: string, input: z.infer<typeof UpdateRoleBody>, meta: RequestMeta) {
    const role = await this.deps.prisma.role.findFirst({ where: { id, organizationId: auth.organizationId }, include: { permissions: true } });
    if (!role) throw AppError.notFound('Role');
    if (role.isSystem) throw AppError.forbidden('System roles cannot be edited. Create a custom role instead.');
    if (input.permissions) this.assertGrantable(auth, input.permissions);
    return this.deps.prisma.$transaction(async (tx) => {
      const updated = await tx.role.update({
        where: { id },
        data: { name: input.name, description: input.description, scope: input.scope, slug: input.name ? slugify(input.name) : undefined },
      });
      if (input.permissions) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({ data: [...new Set(input.permissions)].map((permissionKey) => ({ roleId: id, permissionKey })) });
      }
      await writeAudit(tx, auth, meta, {
        action: 'role.updated',
        entityType: 'role',
        entityId: id,
        before: { ...role, permissions: role.permissions.map((p) => p.permissionKey) },
        after: { ...updated, permissions: input.permissions },
      });
      return updated;
    });
  }

  async remove(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    const role = await this.deps.prisma.role.findFirst({ where: { id, organizationId: auth.organizationId }, include: { _count: { select: { members: true } } } });
    if (!role) throw AppError.notFound('Role');
    if (role.isSystem) throw AppError.forbidden('System roles cannot be deleted');
    if (role._count.members > 0) throw AppError.conflict('Reassign the users of this role before deleting it');
    await this.deps.prisma.role.delete({ where: { id } });
    await writeAudit(this.deps.prisma, auth, meta, { action: 'role.deleted', entityType: 'role', entityId: id, before: role });
  }
}
