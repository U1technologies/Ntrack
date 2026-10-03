import { ALL_PERMISSION_KEYS } from '@ntrack/shared';
import type { PrismaClient } from '@ntrack/db';
import type { AccessScope, AuthContext } from '../types';

interface SessionWithUser {
  id: string;
  mfaVerified: boolean;
  activeOrganizationId: string | null;
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean; mfaEnabled: boolean };
}

const UNRESTRICTED_PLATFORM: AccessScope = { type: 'platform', restricted: false, advertiserIds: [], publisherIds: [] };

/** Resolves role, permissions and data scope for the session's active organization. */
export const buildAuthContext = async (prisma: PrismaClient, session: SessionWithUser): Promise<AuthContext> => {
  const { user } = session;
  const base = {
    sessionId: session.id,
    mfaVerified: session.mfaVerified,
    user: { id: user.id, email: user.email, name: user.name, isPlatformAdmin: user.isPlatformAdmin, mfaEnabled: user.mfaEnabled },
  };
  const organizationId = session.activeOrganizationId;
  const organization = organizationId
    ? await prisma.organization.findUnique({ where: { id: organizationId }, include: { settings: { select: { mfaRequired: true } } } })
    : null;
  const mfaSetupRequired = Boolean(organization?.settings?.mfaRequired) && !user.mfaEnabled;
  const timezone = organization?.timezone ?? 'UTC';

  if (user.isPlatformAdmin) {
    return {
      ...base,
      organizationId: organization?.id ?? null,
      organizationTimezone: timezone,
      role: null,
      permissions: new Set(ALL_PERMISSION_KEYS),
      scope: UNRESTRICTED_PLATFORM,
      mfaSetupRequired,
    };
  }

  const membership =
    organization &&
    (await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: organization.id, userId: user.id } },
      include: { role: { include: { permissions: { select: { permissionKey: true } } } } },
    }));

  if (!organization || !membership || membership.status !== 'active' || organization.status !== 'active') {
    return {
      ...base,
      organizationId: null,
      organizationTimezone: 'UTC',
      role: null,
      permissions: new Set(),
      scope: { type: 'organization', restricted: true, advertiserIds: [], publisherIds: [] },
      mfaSetupRequired: false,
    };
  }

  const { role } = membership;
  let scope: AccessScope;
  switch (role.scope) {
    case 'advertiser':
      scope = { type: 'advertiser', restricted: true, advertiserIds: membership.advertiserId ? [membership.advertiserId] : [], publisherIds: [] };
      break;
    case 'publisher':
      scope = { type: 'publisher', restricted: true, advertiserIds: [], publisherIds: membership.publisherId ? [membership.publisherId] : [] };
      break;
    case 'managed': {
      const assignments = await prisma.managerAssignment.findMany({ where: { organizationId: organization.id, userId: user.id } });
      scope = {
        type: 'managed',
        restricted: true,
        advertiserIds: assignments.flatMap((a) => (a.advertiserId ? [a.advertiserId] : [])),
        publisherIds: assignments.flatMap((a) => (a.publisherId ? [a.publisherId] : [])),
      };
      break;
    }
    default:
      scope = { type: 'organization', restricted: false, advertiserIds: [], publisherIds: [] };
  }

  return {
    ...base,
    organizationId: organization.id,
    organizationTimezone: timezone,
    role: { id: role.id, slug: role.slug, name: role.name, scope: role.scope },
    permissions: new Set(role.permissions.map((p) => p.permissionKey)),
    scope,
    mfaSetupRequired,
  };
};
