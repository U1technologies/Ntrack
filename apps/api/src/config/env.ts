import { z } from 'zod';

const base64Key = z
  .string()
  .min(1)
  .refine((value) => Buffer.from(value, 'base64').length === 32, 'must be a base64-encoded 32-byte key');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  CLICKHOUSE_URL: z.string().default('http://localhost:8123'),
  CLICKHOUSE_DATABASE: z.string().default('ntrack'),
  CLICKHOUSE_USER: z.string().default('default'),
  CLICKHOUSE_PASSWORD: z.string().default(''),
  CONSOLE_ORIGIN: z.string().url(),
  /** Path the console is served under on CONSOLE_ORIGIN; '' when it has its own domain (e.g. app.example.com). */
  CONSOLE_BASE_PATH: z
    .string()
    .regex(/^(\/[a-z0-9-]+)*$/, 'Use a path like /ntrack, or empty')
    .default('/ntrack'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** Browser path the session cookie is scoped to. "/ntrack" in production (console lives under /ntrack). */
  COOKIE_PATH: z.string().startsWith('/').default('/'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),
  ENCRYPTION_KEY: base64Key,
  TRACKING_HASH_SECRET: z.string().min(16),
  TRACKER_CNAME_TARGET: z.string().min(3),
  /** Development only: lets postbacks target localhost/private IPs (e.g. a local webhook receiver). */
  ALLOW_PRIVATE_OUTBOUND: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** Where privacy export archives are written (local disk; object storage in production). */
  DATA_EXPORT_DIR: z.string().default('.local/exports'),
  /** Days an export archive stays downloadable before it is removed. */
  DATA_EXPORT_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  /** Email is sent by the workers; the API only reports whether it is configured. */
  SMTP_HOST: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export type ApiConfig = z.infer<typeof EnvSchema>;

export const loadApiConfig = (env: NodeJS.ProcessEnv = process.env): ApiConfig => {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid API configuration: ${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.ALLOW_PRIVATE_OUTBOUND) {
    throw new Error('ALLOW_PRIVATE_OUTBOUND must not be enabled in production');
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE must be true in production');
  }
  return parsed.data;
};
