import type { PermissionKey } from './permissions';

/** Prefix of every NTrack API key; makes leaked keys easy to recognise and scan for. */
export const API_KEY_PREFIX = 'ntk_live_';
export const API_KEY_PATTERN = /^ntk_live_[A-Za-z0-9_-]{32,64}$/;

/**
 * Permissions an API key can never hold, whoever creates it: account, role, settings and key
 * management, and privacy requests stay with signed-in people.
 */
export const API_KEY_FORBIDDEN_PERMISSIONS: readonly PermissionKey[] = [
  'organizations.manage',
  'users.manage',
  'roles.manage',
  'settings.manage',
  'integrations.manage',
  'privacy.view',
  'privacy.manage',
  'audit.view',
];

/** API areas keys cannot reach at all (sessions, people, roles, organization settings, keys, privacy, personal inbox). */
export const API_KEY_BLOCKED_PATH_PREFIXES = ['/auth', '/users', '/roles', '/organizations', '/api-keys', '/privacy', '/notifications'] as const;
