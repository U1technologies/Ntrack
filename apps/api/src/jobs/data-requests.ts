import { Worker, type ConnectionOptions } from 'bullmq';
import { PrivacyService, enqueueDataRequest } from '../modules/privacy/privacy.service';
import type { AppDeps } from '../types';

export const DATA_REQUEST_QUEUE = 'ntrack-data-requests';

/**
 * Runs approved privacy requests in the API process (they reuse its services and secret box) and
 * sweeps expired export files hourly. BullMQ guarantees each job runs once across replicas.
 */
export const startDataRequests = async (deps: AppDeps, connection: ConnectionOptions) => {
  const service = new PrivacyService(deps, deps.files, enqueueDataRequest(deps));
  await deps.dataRequestQueue.upsertJobScheduler('privacy-sweep', { every: 60 * 60_000 }, { name: 'sweep', data: {}, opts: { removeOnComplete: 50, removeOnFail: 200 } });
  const worker = new Worker<{ requestId?: string }>(
    DATA_REQUEST_QUEUE,
    async (job) => {
      if (job.name === 'sweep') return service.sweep();
      if (job.data.requestId) await service.process(job.data.requestId);
      return { ok: true };
    },
    { connection, concurrency: 2 }
  );
  worker.on('failed', (job, error) => deps.logger.error({ err: error, job: job?.name }, 'privacy job failed'));
  return { worker };
};
