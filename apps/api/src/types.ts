import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ClickHouseClient } from '@ntrack/analytics';
import type { ConfigPublisher } from '@ntrack/config-sync';
import type { ConversionProcessor } from '@ntrack/conversions';
import type { PrismaClient, RoleScope } from '@ntrack/db';
import type { Notifier } from '@ntrack/notifications';
import type { EmailJob } from '@ntrack/shared';
import type { ApiConfig } from './config/env';
import type { SecretBox } from './lib/crypto';
import type { FileStore } from './services/file-store';
import type { Logger } from './lib/logger';

export interface AppDeps {
  config: ApiConfig;
  prisma: PrismaClient;
  redis: Redis;
  clickhouse: ClickHouseClient;
  publisher: ConfigPublisher;
  conversions: ConversionProcessor;
  postbackQueue: Queue;
  emailQueue: Queue<EmailJob>;
  /** Approved privacy requests waiting to run (processed by jobs/data-requests). */
  dataRequestQueue: Queue<{ requestId?: string }>;
  files: FileStore;
  notifier: Notifier;
  secretBox: SecretBox;
  logger: Logger;
}

/**
 * Data-level access. `restricted: false` means every record in the organization; otherwise only
 * records tied to the listed advertisers/publishers (empty lists mean nothing).
 */
export interface AccessScope {
  type: RoleScope | 'platform';
  restricted: boolean;
  advertiserIds: string[];
  publisherIds: string[];
}

export interface AuthContext {
  sessionId: string;
  mfaVerified: boolean;
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean; mfaEnabled: boolean };
  organizationId: string | null;
  organizationTimezone: string;
  role: { id: string; slug: string; name: string; scope: RoleScope } | null;
  permissions: Set<string>;
  scope: AccessScope;
  /** True when the organization requires MFA and the user has not enabled it yet. */
  mfaSetupRequired: boolean;
}

/** Auth context after requireOrganization: the organization is guaranteed. */
export type OrgAuthContext = AuthContext & { organizationId: string };

export interface RequestMeta {
  ip: string;
  userAgent: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}
