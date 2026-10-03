import { ALL_PERMISSION_KEYS, type PermissionKey } from './permissions';

/**
 * Account types from the product spec. A system role is seeded per organization for each one;
 * admins can clone them into custom roles. `scope` decides which records a user of that role
 * can see beyond what their permissions allow:
 *  - organization: everything in the organization
 *  - advertiser:   only data belonging to the advertiser the user is linked to
 *  - publisher:    only data belonging to the publisher the user is linked to
 *  - managed:      only advertisers/publishers the user manages (account/affiliate managers)
 */
export type RoleScope = 'organization' | 'advertiser' | 'publisher' | 'managed';

export const ACCOUNT_TYPES = [
  'network_admin',
  'advertiser',
  'publisher',
  'agency',
  'account_manager',
  'affiliate_manager',
  'finance_manager',
  'analyst',
  'read_only',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export interface SystemRoleTemplate {
  slug: AccountType;
  name: string;
  description: string;
  scope: RoleScope;
  permissions: PermissionKey[];
}

const viewOnly = (keys: PermissionKey[]) => keys.filter((key) => key.endsWith('.view'));

const NETWORK_ADMIN: PermissionKey[] = ALL_PERMISSION_KEYS.filter((key) => key !== 'organizations.manage');

export const SYSTEM_ROLE_TEMPLATES: SystemRoleTemplate[] = [
  {
    slug: 'network_admin',
    name: 'Network Admin',
    description: 'Runs the affiliate network for this organization.',
    scope: 'organization',
    permissions: NETWORK_ADMIN,
  },
  {
    slug: 'advertiser',
    name: 'Advertiser',
    description: 'Advertiser portal user. Sees only their own campaigns and data.',
    scope: 'advertiser',
    permissions: [
      'campaigns.view',
      'campaigns.manage',
      'publishers.view',
      'campaigns.approve',
      'clicks.view',
      'conversions.view',
      'conversions.approve',
      'postbacks.view',
      'postbacks.manage',
      'reports.view',
      'reports.export',
      'finance.view',
      'users.view',
    ],
  },
  {
    slug: 'publisher',
    name: 'Publisher / Affiliate',
    description: 'Publisher portal user. Sees only their own links, traffic and earnings.',
    scope: 'publisher',
    permissions: [
      'publishers.view',
      'fraud.view',
      'campaigns.view',
      'links.view',
      'links.manage',
      'clicks.view',
      'conversions.view',
      'postbacks.view',
      'postbacks.manage',
      'reports.view',
      'reports.export',
      'finance.view',
      'integrations.view',
      'users.view',
    ],
  },
  {
    slug: 'agency',
    name: 'Agency',
    description: 'Agency managing a set of advertisers and publishers on their behalf.',
    scope: 'managed',
    permissions: [
      'advertisers.view',
      'publishers.view',
      'campaigns.view',
      'campaigns.manage',
      'links.view',
      'links.manage',
      'clicks.view',
      'conversions.view',
      'reports.view',
      'reports.export',
    ],
  },
  {
    slug: 'account_manager',
    name: 'Account Manager',
    description: 'Manages assigned advertisers and their campaigns.',
    scope: 'managed',
    permissions: [
      'advertisers.view',
      'advertisers.manage',
      'campaigns.view',
      'campaigns.manage',
      'campaigns.approve',
      'payouts.view',
      'clicks.view',
      'conversions.view',
      'conversions.approve',
      'reports.view',
      'reports.export',
    ],
  },
  {
    slug: 'affiliate_manager',
    name: 'Affiliate Manager',
    description: 'Manages assigned publishers, applications and links.',
    scope: 'managed',
    permissions: [
      'publishers.view',
      'publishers.manage',
      'publishers.approve',
      'campaigns.view',
      'campaigns.approve',
      'payouts.view',
      'links.view',
      'links.manage',
      'clicks.view',
      'conversions.view',
      'fraud.view',
      'reports.view',
      'reports.export',
    ],
  },
  {
    slug: 'finance_manager',
    name: 'Finance Manager',
    description: 'Owns invoices, payouts and financial adjustments.',
    scope: 'organization',
    permissions: [
      'advertisers.view',
      'publishers.view',
      'campaigns.view',
      'payouts.view',
      'conversions.view',
      'finance.view',
      'finance.manage',
      'finance.approve',
      'reports.view',
      'reports.export',
      'audit.view',
    ],
  },
  {
    slug: 'analyst',
    name: 'Analyst',
    description: 'Read access to performance data and reporting.',
    scope: 'organization',
    // Privacy requests name people and their reasons, so general view roles never see them.
    permissions: [...viewOnly(ALL_PERMISSION_KEYS).filter((k) => !['finance.view', 'privacy.view'].includes(k)), 'reports.export', 'reports.schedule'],
  },
  {
    slug: 'read_only',
    name: 'Read-only',
    description: 'View-only access to operational data, without financials.',
    scope: 'organization',
    permissions: viewOnly(ALL_PERMISSION_KEYS).filter((k) => !['finance.view', 'audit.view', 'payouts.view', 'privacy.view'].includes(k)),
  },
];
