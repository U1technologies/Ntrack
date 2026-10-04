// CLI entry: applies ClickHouse migrations using CLICKHOUSE_* environment variables.
// Retries while ClickHouse is still starting (e.g. a fresh private service on Render), so a
// deploy does not fail just because the database came up a little later than the API.
import { analyticsConfigFromEnv } from './client';
import { migrateAnalytics } from './migrate';

const ATTEMPTS = Number(process.env.ANALYTICS_MIGRATE_ATTEMPTS ?? 30);
const WAIT_MS = 10_000;
const TRANSIENT = /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|socket hang up|Timeout/i;

const run = async () => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await migrateAnalytics(analyticsConfigFromEnv());
      return;
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      if (attempt >= ATTEMPTS || !TRANSIENT.test(message)) throw error;
      console.log(`ClickHouse not reachable yet (${message}); retry ${attempt}/${ATTEMPTS - 1} in ${WAIT_MS / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    }
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
