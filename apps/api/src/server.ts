import { Redis } from 'ioredis';
import { createApp } from './app';
import { loadApiConfig } from './config/env';
import { closeDeps, createDeps } from './deps';
import { startDataRequests } from './jobs/data-requests';
import { startScheduledReports } from './jobs/scheduled-reports';
import { ensureDefaultFraudRules, syncPermissionCatalogue, syncSystemRoles } from './services/provisioning';

const config = loadApiConfig();
const deps = createDeps(config);
await syncPermissionCatalogue(deps.prisma);
// Keep every organization's system roles identical to the code templates after an upgrade.
for (const { id } of await deps.prisma.organization.findMany({ select: { id: true } })) {
  await syncSystemRoles(deps.prisma, id);
  await ensureDefaultFraudRules(deps.prisma, id);
}

const jobRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const scheduledReports = await startScheduledReports(deps, jobRedis);
const dataRequests = await startDataRequests(deps, jobRedis);

const server = createApp(deps).listen(config.API_PORT, () => deps.logger.info({ port: config.API_PORT }, 'NTrack API listening'));

const shutdown = (signal: string) => {
  deps.logger.info({ signal }, 'shutting down API');
  server.close(async () => {
    await scheduledReports.worker.close();
    await dataRequests.worker.close();
    await scheduledReports.queue.close();
    jobRedis.disconnect();
    await closeDeps(deps);
    process.exit(0);
  });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
