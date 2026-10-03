import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { analyticsConfigFromEnv, createAnalyticsClient } from '@ntrack/analytics';
import { ConfigPublisher } from '@ntrack/config-sync';
import { ConversionProcessor } from '@ntrack/conversions';
import { prisma } from '@ntrack/db';
import { Notifier } from '@ntrack/notifications';
import { EMAIL_QUEUE, POSTBACK_QUEUE, type EmailJob } from '@ntrack/shared';
import type { ApiConfig } from './config/env';
import { SecretBox } from './lib/crypto';
import { DATA_REQUEST_QUEUE } from './jobs/data-requests';
import { LocalFileStore } from './services/file-store';
import { logger } from './lib/logger';
import type { AppDeps } from './types';

export const createDeps = (config: ApiConfig): AppDeps => {
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
  // BullMQ needs a connection that never gives up on a request.
  const queueRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const clickhouse = createAnalyticsClient(analyticsConfigFromEnv());
  const postbackQueue = new Queue(POSTBACK_QUEUE, { connection: queueRedis });
  const emailQueue = new Queue<EmailJob>(EMAIL_QUEUE, { connection: queueRedis });
  const dataRequestQueue = new Queue<{ requestId?: string }>(DATA_REQUEST_QUEUE, { connection: queueRedis });
  const notifier = new Notifier({ prisma, redis, emailQueue, consoleOrigin: config.CONSOLE_ORIGIN, log: logger });
  return {
    config,
    prisma,
    redis,
    clickhouse,
    publisher: new ConfigPublisher(redis, prisma),
    postbackQueue,
    emailQueue,
    dataRequestQueue,
    files: new LocalFileStore(config.DATA_EXPORT_DIR),
    notifier,
    conversions: new ConversionProcessor({ prisma, redis, clickhouse, postbackQueue, notifier, log: logger }),
    secretBox: new SecretBox(config.ENCRYPTION_KEY),
    logger,
  };
};

export const closeDeps = async (deps: AppDeps) => {
  await Promise.allSettled([deps.prisma.$disconnect(), deps.clickhouse.close(), deps.postbackQueue.close(), deps.emailQueue.close(), deps.dataRequestQueue.close(), deps.redis.quit()]);
};
