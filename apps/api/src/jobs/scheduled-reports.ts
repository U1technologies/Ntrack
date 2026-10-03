import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { ScheduledReportsService } from '../modules/scheduled-reports/scheduled-reports.service';
import type { AppDeps } from '../types';

const QUEUE = 'ntrack-scheduled-reports';

/**
 * Runs in the API process because reports reuse the API's report service and permission model.
 * The job scheduler is an idempotent upsert, so every API replica can start this safely and
 * BullMQ still runs each tick once across the fleet.
 */
export const startScheduledReports = async (deps: AppDeps, connection: ConnectionOptions) => {
  const queue = new Queue(QUEUE, { connection });
  await queue.upsertJobScheduler('scheduled-reports', { every: 5 * 60_000 }, { name: 'run-due', opts: { removeOnComplete: 100, removeOnFail: 500 } });
  const service = new ScheduledReportsService(deps);
  const worker = new Worker(QUEUE, async () => ({ ran: await service.runDue() }), { connection, concurrency: 1 });
  worker.on('failed', (_job, error) => deps.logger.error({ err: error }, 'scheduled reports tick failed'));
  return { queue, worker };
};
