// Local PostgreSQL for machines without Docker. Data lives in .local/postgres (git-ignored).
// Prefer `docker compose -f infra/docker-compose.yml up` when Docker is available.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';

const port = Number(process.env.LOCAL_PG_PORT || 5432);
const databaseDir = new URL('../.local/postgres', import.meta.url).pathname;
const isFresh = !existsSync(databaseDir);

const pg = new EmbeddedPostgres({
  databaseDir,
  user: 'ntrack',
  password: process.env.LOCAL_PG_PASSWORD || 'ntrack_local',
  port,
  persistent: true,
});

if (isFresh) await pg.initialise();
await pg.start();
if (isFresh) await pg.createDatabase('ntrack_app');
console.log(`PostgreSQL running on localhost:${port} (database: ntrack_app). Ctrl+C to stop.`);

const shutdown = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
