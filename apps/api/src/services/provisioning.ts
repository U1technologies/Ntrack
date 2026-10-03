import { ALL_PERMISSIONS, DEFAULT_FRAUD_RULES, DEFAULT_PARAM_MAP, SYSTEM_ROLE_TEMPLATES, generatePublicId } from '@ntrack/shared';
import type { Prisma, PrismaClient } from '@ntrack/db';

/** Keeps the permissions table identical to the code catalogue (adds new keys, removes retired ones). */
export const syncPermissionCatalogue = async (prisma: PrismaClient) => {
  await prisma.$transaction([
    ...ALL_PERMISSIONS.map((p) =>
      prisma.permission.upsert({ where: { key: p.key }, create: { key: p.key, module: p.module, label: p.label }, update: { module: p.module, label: p.label } })
    ),
    prisma.permission.deleteMany({ where: { key: { notIn: ALL_PERMISSIONS.map((p) => p.key) } } }),
  ]);
};

/** Creates or refreshes the system roles of one organization from the templates. */
export const syncSystemRoles = async (db: Prisma.TransactionClient | PrismaClient, organizationId: string) => {
  for (const template of SYSTEM_ROLE_TEMPLATES) {
    const role = await db.role.upsert({
      where: { organizationId_slug: { organizationId, slug: template.slug } },
      create: { organizationId, slug: template.slug, name: template.name, description: template.description, scope: template.scope, isSystem: true },
      update: { name: template.name, description: template.description, scope: template.scope, isSystem: true },
    });
    await db.rolePermission.deleteMany({ where: { roleId: role.id } });
    await db.rolePermission.createMany({ data: template.permissions.map((permissionKey) => ({ roleId: role.id, permissionKey })) });
  }
};

/** Seeds the default fraud rules once per organization (admins can edit or disable them). */
export const ensureDefaultFraudRules = async (db: Prisma.TransactionClient | PrismaClient, organizationId: string) => {
  if (await db.fraudRule.count({ where: { organizationId } })) return;
  await db.fraudRule.createMany({ data: DEFAULT_FRAUD_RULES.map((rule) => ({ ...rule, organizationId })) });
};

export interface NewOrganization {
  name: string;
  slug: string;
  timezone?: string;
  currency?: string;
}

export const provisionOrganization = (prisma: PrismaClient, input: NewOrganization) =>
  prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        publicId: generatePublicId('org'),
        name: input.name,
        slug: input.slug,
        timezone: input.timezone ?? 'UTC',
        currency: input.currency ?? 'USD',
        settings: { create: { paramMap: DEFAULT_PARAM_MAP as unknown as Prisma.InputJsonValue } },
      },
    });
    await syncSystemRoles(tx, organization.id);
    await ensureDefaultFraudRules(tx, organization.id);
    return organization;
  });
