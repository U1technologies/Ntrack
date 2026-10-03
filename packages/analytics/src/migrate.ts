import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createClient } from '@clickhouse/client';
import { createAnalyticsClient, type AnalyticsConfig } from './client';

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/** Applies pending ClickHouse migrations in filename order and records them in schema_migrations. */
export const migrateAnalytics = async (
  config: AnalyticsConfig,
  log: (msg: string) => void = console.log,
  migrationsDir: string = process.env.ANALYTICS_MIGRATIONS_DIR ?? DEFAULT_MIGRATIONS_DIR
) => {
  const bootstrap = createClient({ url: config.url, username: config.username, password: config.password });
  await bootstrap.command({ query: `CREATE DATABASE IF NOT EXISTS ${config.database.replace(/[^a-zA-Z0-9_]/g, '')}` });
  await bootstrap.close();

  const client = createAnalyticsClient(config);
  try {
    await client.command({
      query: `CREATE TABLE IF NOT EXISTS schema_migrations (name String, applied_at DateTime DEFAULT now())
              ENGINE = MergeTree ORDER BY name`,
    });
    const applied = new Set(
      (await (await client.query({ query: 'SELECT name FROM schema_migrations', format: 'JSONEachRow' })).json<{ name: string }>()).map(
        (row) => row.name
      )
    );
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(`${migrationsDir}/${file}`, 'utf8');
      const statements = sql
        .split(/;\s*$/m)
        .map((statement) => statement.replace(/^\s*--.*$/gm, '').trim())
        .filter(Boolean);
      for (const statement of statements) await client.command({ query: statement });
      await client.insert({ table: 'schema_migrations', values: [{ name: file }], format: 'JSONEachRow' });
      log(`applied ${file}`);
    }
  } finally {
    await client.close();
  }
};
