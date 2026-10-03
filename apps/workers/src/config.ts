import { analyticsConfigFromEnv, type AnalyticsConfig } from '@ntrack/analytics';

export interface WorkerConfig {
  redisUrl: string;
  encryptionKey: string;
  allowPrivateOutbound: boolean;
  analytics: AnalyticsConfig;
  logLevel: string;
  clickBatchSize: number;
  configSyncEveryMs: number;
  domainHealthEveryMs: number;
  /** Console origin for links in notification emails, e.g. https://nextagmedia.com */
  consoleOrigin: string;
}

export const loadWorkerConfig = (env: NodeJS.ProcessEnv = process.env): WorkerConfig => {
  if (!env.REDIS_URL) throw new Error('Missing required environment variable REDIS_URL');
  if (!env.DATABASE_URL) throw new Error('Missing required environment variable DATABASE_URL');
  if (!env.ENCRYPTION_KEY) throw new Error('Missing required environment variable ENCRYPTION_KEY');
  return {
    redisUrl: env.REDIS_URL,
    encryptionKey: env.ENCRYPTION_KEY,
    allowPrivateOutbound: (() => {
      const enabled = env.ALLOW_PRIVATE_OUTBOUND === 'true';
      if (enabled && env.NODE_ENV === 'production') throw new Error('ALLOW_PRIVATE_OUTBOUND must not be enabled in production');
      return enabled;
    })(),
    analytics: analyticsConfigFromEnv(env),
    logLevel: env.LOG_LEVEL ?? 'info',
    clickBatchSize: Number(env.CLICK_BATCH_SIZE ?? 1000),
    configSyncEveryMs: Number(env.CONFIG_SYNC_EVERY_MS ?? 5 * 60_000),
    domainHealthEveryMs: Number(env.DOMAIN_HEALTH_EVERY_MS ?? 15 * 60_000),
    consoleOrigin: env.CONSOLE_ORIGIN ?? '',
  };
};
