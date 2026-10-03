import { Worker, type ConnectionOptions } from 'bullmq';
import type { EmailSender } from '@ntrack/notifications';
import { EMAIL_QUEUE, type EmailJob } from '@ntrack/shared';
import type { Logger } from '../logger';

/**
 * Sends queued emails. When SMTP is not configured the jobs complete as `skipped` so the queue
 * does not grow; in-app notifications are unaffected.
 */
export const startEmailWorker = (connection: ConnectionOptions, sender: EmailSender, log: Logger) => {
  if (!sender.enabled) log.warn('SMTP is not configured (SMTP_HOST / SMTP_FROM); emails are skipped, in-app notifications still work');
  const worker = new Worker<EmailJob>(
    EMAIL_QUEUE,
    async (job) => {
      if (!sender.enabled) return { status: 'skipped' };
      await sender.send(job.data);
      return { status: 'sent' };
    },
    // Low concurrency and a rate limiter keep us inside typical SMTP provider limits.
    { connection, concurrency: 5, limiter: { max: 20, duration: 1000 } }
  );
  // Recipient addresses are not logged.
  worker.on('failed', (job, error) => log.warn({ jobId: job?.id, attempt: job?.attemptsMade, err: error.message }, 'email delivery attempt failed'));
  return worker;
};
