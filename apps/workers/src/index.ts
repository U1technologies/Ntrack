import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createAnalyticsClient } from '@ntrack/analytics';
import { ConfigPublisher } from '@ntrack/config-sync';
import { ConversionProcessor } from '@ntrack/conversions';
import { prisma } from '@ntrack/db';
import { Notifier, createEmailSender, smtpConfigFromEnv } from '@ntrack/notifications';
import { EMAIL_QUEUE, POSTBACK_QUEUE, SecretBox, type EmailJob } from '@ntrack/shared';
import { loadWorkerConfig } from './config';
import { ClickIngestor } from './jobs/click-ingest';
import { ConversionConsumer } from './jobs/conversion-consumer';
import { startEmailWorker } from './jobs/email-worker';
import { startMaintenance } from './jobs/maintenance';
import { startPostbackWorker } from './jobs/postback-worker';
import { logger } from './logger';

const config = loadWorkerConfig();
// The stream consumer blocks on XREADGROUP, so it gets its own connection.
const streamRedis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const conversionRedis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const clickhouse = createAnalyticsClient(config.analytics);

const secretBox = new SecretBox(config.encryptionKey);
const postbackQueue = new Queue(POSTBACK_QUEUE, { connection: redis });
const emailQueue = new Queue<EmailJob>(EMAIL_QUEUE, { connection: redis });
const notifier = new Notifier({ prisma, redis, emailQueue, consoleOrigin: config.consoleOrigin, log: logger });
const processor = new ConversionProcessor({ prisma, redis, clickhouse, postbackQueue, notifier, log: logger });

const ingestor = new ClickIngestor(streamRedis, clickhouse, logger, config.clickBatchSize, (hits) => {
  for (const hit of hits) {
    notifier.emit({
      organizationId: hit.organizationId,
      type: 'cap.reached',
      title: 'Daily click cap reached',
      body: 'A campaign reached its daily click cap. Further clicks today go to the fallback URL (or the unavailable page) and are recorded as invalid.',
      link: `/ntrack/campaigns/${hit.campaignId}`,
      subject: { advertiserId: hit.advertiserId },
      dedupeKey: `cap:clicks:${hit.campaignId}:${hit.day}`,
      dedupeTtlSeconds: 2 * 86_400,
    });
  }
});
const conversions = new ConversionConsumer(conversionRedis, processor, logger);
const maintenance = await startMaintenance(redis, new ConfigPublisher(redis), logger, config, clickhouse, notifier);
const postbackWorker = startPostbackWorker(redis, secretBox, logger, config.allowPrivateOutbound, notifier);
const emailWorker = startEmailWorker(redis, createEmailSender(smtpConfigFromEnv()), logger);
void ingestor.start();
void conversions.start();

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down workers');
  ingestor.stop();
  conversions.stop();
  await postbackWorker.close();
  await emailWorker.close();
  await postbackQueue.close();
  await emailQueue.close();
  await maintenance.worker.close();
  await maintenance.queue.close();
  await clickhouse.close();
  await prisma.$disconnect();
  streamRedis.disconnect();
  conversionRedis.disconnect();
  redis.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
