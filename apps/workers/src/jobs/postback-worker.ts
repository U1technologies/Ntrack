import { Worker, type ConnectionOptions } from 'bullmq';
import { performDelivery } from '@ntrack/conversions';
import { prisma } from '@ntrack/db';
import type { Notifier } from '@ntrack/notifications';
import { POSTBACK_QUEUE, type SecretBox } from '@ntrack/shared';
import type { Logger } from '../logger';

/** Delivers outbound postbacks/webhooks with exponential backoff (8 attempts, see POSTBACK_JOB_OPTIONS). */
/** Tells the postback owner when a delivery has failed for good (once per postback per hour). */
const notifyFinalFailure = async (notifier: Notifier, deliveryId: string) => {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    select: { status: true, postback: { select: { id: true, name: true, organizationId: true, publisherId: true, campaign: { select: { advertiserId: true } } } } },
  });
  if (!delivery || delivery.status !== 'failed') return;
  const { postback } = delivery;
  await notifier.notify({
    organizationId: postback.organizationId,
    type: 'postback.failed',
    title: `Postback failing: ${postback.name}`,
    body: 'A delivery failed after all retries. Check the endpoint, then replay it from the delivery log.',
    link: '/ntrack/postbacks',
    subject: { publisherId: postback.publisherId, advertiserId: postback.campaign?.advertiserId ?? null },
    dedupeKey: `postback:${postback.id}`,
    dedupeTtlSeconds: 3600,
  });
};

export const startPostbackWorker = (connection: ConnectionOptions, secretBox: SecretBox, log: Logger, allowPrivateNetwork = false, notifier?: Notifier) => {
  const worker = new Worker<{ deliveryId: string }>(
    POSTBACK_QUEUE,
    async (job) => {
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      try {
        await performDelivery(prisma, secretBox, job.data.deliveryId, { finalAttempt, allowPrivateNetwork });
      } finally {
        if (finalAttempt && notifier) {
          await notifyFinalFailure(notifier, job.data.deliveryId).catch((error: unknown) => log.error({ err: error }, 'postback failure notification failed'));
        }
      }
    },
    { connection, concurrency: 20 }
  );
  worker.on('failed', (job, error) => log.warn({ deliveryId: job?.data.deliveryId, attempt: job?.attemptsMade, err: error.message }, 'postback delivery attempt failed'));
  return worker;
};
