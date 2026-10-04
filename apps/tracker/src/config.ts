const required = (name: string, value: string | undefined): string => {
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

const proxySecretFrom = (value: string | undefined): string => {
  const secret = value?.trim() ?? '';
  if (secret && secret.length < 32) throw new Error('TRACKER_PROXY_SECRET must be at least 32 characters');
  return secret;
};

export interface TrackerConfig {
  port: number;
  redisUrl: string;
  hashSecret: string;
  trustProxy: boolean;
  /** Shared with the website that forwards /click etc.; '' when the tracker is reached directly. */
  proxySecret: string;
  devHostOverride: string;
  logLevel: string;
  /** JSON file produced by scripts/update-datacenter-ranges.mjs; '' looks in the default locations. */
  datacenterRangesFile: string;
}

export const loadTrackerConfig = (env: NodeJS.ProcessEnv = process.env): TrackerConfig => {
  const isProduction = env.NODE_ENV === 'production';
  const devHostOverride = env.TRACKER_DEV_HOST_OVERRIDE ?? '';
  if (isProduction && devHostOverride) throw new Error('TRACKER_DEV_HOST_OVERRIDE must not be set in production');
  return {
    port: Number(env.TRACKER_PORT ?? 4100),
    redisUrl: required('REDIS_URL', env.REDIS_URL),
    hashSecret: required('TRACKING_HASH_SECRET', env.TRACKING_HASH_SECRET),
    trustProxy: env.TRUST_PROXY === 'true',
    proxySecret: proxySecretFrom(env.TRACKER_PROXY_SECRET),
    devHostOverride,
    logLevel: env.LOG_LEVEL ?? 'info',
    datacenterRangesFile: env.DATACENTER_RANGES_FILE ?? '',
  };
};
