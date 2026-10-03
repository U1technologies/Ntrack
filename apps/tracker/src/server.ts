import { Redis } from 'ioredis';
import { buildTracker } from './app';
import { loadTrackerConfig } from './config';
import { loadDatacenterMatcher } from './services/datacenter-ranges';
import { RedisTrackerStore } from './services/tracker-store';

const config = loadTrackerConfig();
const redis = new Redis(config.redisUrl, { enableAutoPipelining: true, maxRetriesPerRequest: 2 });
const bootLog = { info: (obj: object, msg: string) => console.info(msg, obj), warn: (obj: object, msg: string) => console.warn(msg, obj) };
const app = buildTracker(new RedisTrackerStore(redis), config, { datacenter: loadDatacenterMatcher(config.datacenterRangesFile, bootLog) });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down tracker');
  await app.close();
  await redis.quit();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

app.listen({ port: config.port, host: '0.0.0.0' }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
