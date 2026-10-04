import { createClient, type ClickHouseClient } from '@clickhouse/client';

export interface AnalyticsConfig {
  url: string;
  database: string;
  username: string;
  password: string;
}

/** Accepts "host:port" (as Render's private network gives it) as well as a full http(s) URL. */
export const normalizeClickhouseUrl = (url: string): string => (/^https?:\/\//i.test(url) ? url : `http://${url}`);

export const analyticsConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): AnalyticsConfig => ({
  url: env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  database: env.CLICKHOUSE_DATABASE ?? 'ntrack',
  username: env.CLICKHOUSE_USER ?? 'default',
  password: env.CLICKHOUSE_PASSWORD ?? '',
});

export const createAnalyticsClient = (config: AnalyticsConfig): ClickHouseClient =>
  createClient({
    url: normalizeClickhouseUrl(config.url),
    database: config.database,
    username: config.username,
    password: config.password,
    request_timeout: 30_000,
    clickhouse_settings: { date_time_output_format: 'iso' },
  });

export type { ClickHouseClient };
