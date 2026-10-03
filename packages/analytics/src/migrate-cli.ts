// CLI entry: applies ClickHouse migrations using CLICKHOUSE_* environment variables.
import { analyticsConfigFromEnv } from './client';
import { migrateAnalytics } from './migrate';

migrateAnalytics(analyticsConfigFromEnv()).catch((error) => {
  console.error(error);
  process.exit(1);
});
