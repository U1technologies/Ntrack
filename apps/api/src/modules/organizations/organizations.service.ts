import type { Prisma } from '@ntrack/db';
import { AppError } from '../../lib/errors';
import { writeAudit } from '../../services/audit';
import { provisionOrganization } from '../../services/provisioning';
import type { AppDeps, AuthContext, OrgAuthContext, RequestMeta } from '../../types';
import type { z } from 'zod';
import type { CreateOrganizationBody, UpdateOrganizationBody, UpdateSettingsBody } from './organizations.schemas';

export class OrganizationsService {
  constructor(private readonly deps: AppDeps) {}

  list() {
    return this.deps.prisma.organization.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { members: true, advertisers: true, publishers: true, campaigns: true } } },
    });
  }

  async create(auth: AuthContext, input: z.infer<typeof CreateOrganizationBody>, meta: RequestMeta) {
    const organization = await provisionOrganization(this.deps.prisma, input);
    await writeAudit(this.deps.prisma, auth, meta, { action: 'organization.created', entityType: 'organization', entityId: organization.id, organizationId: organization.id, after: organization });
    return organization;
  }

  async update(auth: AuthContext, id: string, input: z.infer<typeof UpdateOrganizationBody>, meta: RequestMeta) {
    const before = await this.deps.prisma.organization.findUnique({ where: { id } });
    if (!before) throw AppError.notFound('Organization');
    const after = await this.deps.prisma.organization.update({ where: { id }, data: input });
    await writeAudit(this.deps.prisma, auth, meta, { action: 'organization.updated', entityType: 'organization', entityId: id, organizationId: id, before, after });
    if (input.timezone) await this.deps.publisher.publishOrganizationCampaigns(id);
    return after;
  }

  async current(auth: OrgAuthContext) {
    const organization = await this.deps.prisma.organization.findUnique({ where: { id: auth.organizationId }, include: { settings: true } });
    if (!organization) throw AppError.notFound('Organization');
    return organization;
  }

  async updateSettings(auth: OrgAuthContext, input: z.infer<typeof UpdateSettingsBody>, meta: RequestMeta) {
    const before = await this.deps.prisma.organizationSettings.findUniqueOrThrow({ where: { organizationId: auth.organizationId } });
    const after = await this.deps.prisma.organizationSettings.update({
      where: { organizationId: auth.organizationId },
      data: { ...input, paramMap: input.paramMap ? (input.paramMap as Prisma.InputJsonValue) : undefined },
    });
    await writeAudit(this.deps.prisma, auth, meta, { action: 'settings.updated', entityType: 'organization_settings', entityId: auth.organizationId, before, after });
    await this.deps.publisher.publishOrganizationCampaigns(auth.organizationId);
    return after;
  }
}
