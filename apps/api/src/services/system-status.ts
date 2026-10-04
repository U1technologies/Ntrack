import { REDIS_KEYS } from '@ntrack/shared';
import type { AppDeps } from '../types';

export type CheckResult = 'ok' | 'fail';

/** Config sync runs every 5 minutes; a heartbeat older than this means the workers are down. */
const WORKER_STALE_MS = 15 * 60_000;
/** Click events waiting for ClickHouse; above this the ingest worker is falling behind. */
const MAX_CLICK_BACKLOG = 50_000;
const CHECK_TIMEOUT_MS = 3000;

const withTimeout = async (check: () => Promise<boolean>): Promise<CheckResult> => {
  try {
    const passed = await Promise.race([check(), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), CHECK_TIMEOUT_MS))]);
    return passed ? 'ok' : 'fail';
  } catch {
    return 'fail';
  }
};

/** Unprocessed entries (lag, else pending) for a consumer group on a stream; null when unknown. */
const streamBacklog = async (deps: AppDeps, stream: string, group: string): Promise<number | null> => {
  const groups = (await deps.redis.call('XINFO', 'GROUPS', stream)) as unknown[][];
  for (const raw of groups) {
    const info: Record<string, unknown> = {};
    for (let i = 0; i < raw.length; i += 2) info[String(raw[i])] = raw[i + 1];
    if (info.name !== group) continue;
    const lag = info.lag === null || info.lag === undefined ? null : Number(info.lag);
    return lag ?? Number(info.pending ?? 0);
  }
  return null;
};

/**
 * Health of everything NTrack needs to record clicks and conversions, for uptime monitors.
 * Only pass/fail per component is returned (no versions, hosts or error text).
 */
export const systemStatus = async (deps: AppDeps) => {
  const [database, redis, clickhouse, workers, clickQueue] = await Promise.all([
    withTimeout(async () => (await deps.prisma.$queryRaw<unknown[]>`SELECT 1`).length === 1),
    withTimeout(async () => (await deps.redis.ping()) === 'PONG'),
    withTimeout(async () => (await deps.clickhouse.ping()).success),
    withTimeout(async () => {
      const syncedAt = await deps.redis.get(REDIS_KEYS.configSyncedAt);
      return Boolean(syncedAt) && Date.now() - Date.parse(syncedAt!) < WORKER_STALE_MS;
    }),
    withTimeout(async () => {
      const backlog = await streamBacklog(deps, REDIS_KEYS.clickStream, 'clickhouse-ingest');
      return backlog === null || backlog < MAX_CLICK_BACKLOG;
    }),
  ]);
  const checks = { database, redis, clickhouse, workers, clickQueue };
  const healthy = Object.values(checks).every((result) => result === 'ok');
  return { healthy, status: healthy ? 'ok' : 'degraded', checks, checkedAt: new Date().toISOString() };
};
