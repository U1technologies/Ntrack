import type { EmailJob } from '@ntrack/shared';
import type { AppDeps } from '../types';

/** Absolute console URL for a console path, from configuration (never from the request). */
export const consoleUrl = (config: AppDeps['config'], path: string): string => `${config.CONSOLE_ORIGIN.replace(/\/$/, '')}${config.CONSOLE_BASE_PATH}${path}`;

export const emailConfigured = (config: AppDeps['config']): boolean => Boolean(config.SMTP_HOST && config.SMTP_FROM);

/**
 * Queues an account email. Delivery happens in the workers; when SMTP is not configured the job is
 * skipped there, which is why invitation flows also return a copyable link to the admin.
 */
export const queueAccountEmail = async (deps: AppDeps, to: string, email: Omit<EmailJob, 'to'>, name: string) => {
  await deps.emailQueue.add(name, { to, ...email }, { attempts: 5, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: 1000, removeOnFail: 5000 });
};
