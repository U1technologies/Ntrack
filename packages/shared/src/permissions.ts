/**
 * Permission catalogue. Keys follow `<module>.<action>` and are the single source of truth for
 * the API (requirePermission middleware), the seed script (permissions table) and the console
 * (sidebar visibility). Adding a module means adding its keys here first.
 */
export const PERMISSION_GROUPS = {
  organizations: {
    label: 'Organizations',
    actions: { view: 'View organizations', manage: 'Create and edit organizations' },
  },
  users: {
    label: 'Users',
    actions: { view: 'View users', manage: 'Invite, edit and deactivate users' },
  },
  roles: {
    label: 'Roles & permissions',
    actions: { view: 'View roles', manage: 'Create and edit custom roles' },
  },
  advertisers: {
    label: 'Advertisers',
    actions: { view: 'View advertisers', manage: 'Create and edit advertisers' },
  },
  publishers: {
    label: 'Publishers',
    actions: { view: 'View publishers', manage: 'Create and edit publishers', approve: 'Approve or reject publishers' },
  },
  campaigns: {
    label: 'Campaigns',
    actions: {
      view: 'View campaigns',
      manage: 'Create and edit campaigns',
      approve: 'Approve campaigns and publisher applications',
      delete: 'Delete campaigns',
    },
  },
  payouts: {
    label: 'Payout tiers',
    actions: { view: 'View payout and revenue rates', manage: 'Change payout and revenue rates' },
  },
  domains: {
    label: 'Tracking domains',
    actions: { view: 'View tracking domains', manage: 'Add, verify and configure tracking domains' },
  },
  links: {
    label: 'Tracking links',
    actions: { view: 'View tracking links', manage: 'Generate and edit tracking links' },
  },
  clicks: {
    label: 'Clicks',
    actions: { view: 'View click logs' },
  },
  conversions: {
    label: 'Conversions',
    actions: { view: 'View conversions', manage: 'Create and adjust conversions', approve: 'Approve, reject and reverse conversions' },
  },
  postbacks: {
    label: 'Postbacks & webhooks',
    actions: { view: 'View postbacks and delivery logs', manage: 'Configure postbacks and webhooks' },
  },
  attribution: {
    label: 'Attribution',
    actions: { view: 'View attribution settings', manage: 'Configure attribution rules' },
  },
  reports: {
    label: 'Reports',
    actions: { view: 'View reports', export: 'Export reports', schedule: 'Schedule reports' },
  },
  finance: {
    label: 'Finance',
    actions: { view: 'View financial data', manage: 'Create invoices and adjustments', approve: 'Approve payouts' },
  },
  fraud: {
    label: 'Fraud detection',
    actions: { view: 'View fraud events', manage: 'Review fraud events and manage rules' },
  },
  search: {
    label: 'Search monetization',
    actions: { view: 'View search monetization', manage: 'Manage search partners and revenue' },
  },
  travel: {
    label: 'Travel campaigns',
    actions: { view: 'View travel campaigns', manage: 'Manage travel partners and bookings' },
  },
  integrations: {
    label: 'Integrations & API',
    actions: { view: 'View integrations and API keys', manage: 'Manage integrations and API keys' },
  },
  notifications: {
    label: 'Notifications',
    actions: { manage: 'Manage notification settings' },
  },
  settings: {
    label: 'Settings',
    actions: { view: 'View organization settings', manage: 'Change organization settings' },
  },
  audit: {
    label: 'Audit logs',
    actions: { view: 'View audit logs' },
  },
} as const;

type Groups = typeof PERMISSION_GROUPS;
export type PermissionModule = keyof Groups;
export type PermissionKey = {
  [M in PermissionModule]: `${M}.${Extract<keyof Groups[M]['actions'], string>}`;
}[PermissionModule];

export interface PermissionDefinition {
  key: PermissionKey;
  module: PermissionModule;
  label: string;
}

export const ALL_PERMISSIONS: PermissionDefinition[] = (Object.keys(PERMISSION_GROUPS) as PermissionModule[]).flatMap(
  (module) =>
    Object.entries(PERMISSION_GROUPS[module].actions).map(([action, label]) => ({
      key: `${module}.${action}` as PermissionKey,
      module,
      label: label as string,
    }))
);

export const ALL_PERMISSION_KEYS: PermissionKey[] = ALL_PERMISSIONS.map((p) => p.key);

export const isPermissionKey = (value: string): value is PermissionKey =>
  (ALL_PERMISSION_KEYS as string[]).includes(value);

/** True when `granted` contains at least one of `required`. */
export const hasAnyPermission = (granted: Iterable<string>, required: PermissionKey | PermissionKey[]): boolean => {
  const set = granted instanceof Set ? granted : new Set(granted);
  const list = Array.isArray(required) ? required : [required];
  return list.some((key) => set.has(key));
};
