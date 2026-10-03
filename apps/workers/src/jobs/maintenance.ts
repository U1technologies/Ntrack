import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { ConfigPublisher } from '@ntrack/config-sync';
import { prisma } from '@ntrack/db';
import type { Notifier } from '@ntrack/notifications';
import { checkDomainHealth, lookupDomainExpiry } from '@ntrack/shared';
import type { ClickHouseClient } from '@ntrack/analytics';
import type { Logger } from '../logger';
import { runBudgetGuard } from './budget-guard';
import { runFraudScan } from './fraud-scan';
import { reconcileLedger } from './ledger-reconcile';

export const MAINTENANCE_QUEUE = 'ntrack-maintenance';

type MaintenanceJob = 'config-sync' | 'domain-health' | 'session-cleanup' | 'fraud-scan' | 'ledger-reconcile' | 'budget-guard';

/** Checks every non-pending domain, stores the result history and updates the domain summary. */
export const runDomainHealthChecks = async (log: Logger, notifier?: Notifier): Promise<number> => {
  const domains = await prisma.trackingDomain.findMany({ where: { status: { in: ['active', 'failed'] } } });
  for (const domain of domains) {
    const health = await checkDomainHealth(domain.hostname);
    const needsExpiry = !domain.domainExpiresAt || domain.domainExpiresAt.getTime() - Date.now() < 30 * 86_400_000;
    const domainExpiresAt = needsExpiry ? ((await lookupDomainExpiry(domain.hostname)) ?? domain.domainExpiresAt) : domain.domainExpiresAt;
    const ok = health.dnsOk && health.httpsOk;
    await prisma.$transaction([
      prisma.domainHealthCheck.create({
        data: {
          domainId: domain.id,
          dnsOk: health.dnsOk,
          httpsOk: health.httpsOk,
          statusCode: health.statusCode,
          latencyMs: health.latencyMs,
          sslExpiresAt: health.sslExpiresAt,
          error: health.error,
        },
      }),
      prisma.trackingDomain.update({
        where: { id: domain.id },
        data: {
          lastCheckedAt: new Date(),
          lastCheckOk: ok,
          lastLatencyMs: health.latencyMs,
          lastError: health.error,
          sslExpiresAt: health.sslExpiresAt ?? domain.sslExpiresAt,
          sslStatus: health.sslExpiresAt ? (health.sslExpiresAt.getTime() > Date.now() ? 'valid' : 'expired') : domain.sslStatus,
          domainExpiresAt,
        },
      }),
    ]);
    if (!ok) {
      log.warn({ hostname: domain.hostname, error: health.error }, 'tracking domain health check failed');
      await notifier
        ?.notify({
          organizationId: domain.organizationId,
          type: 'domain.failed',
          title: `Tracking domain failing: ${domain.hostname}`,
          body: `${health.dnsOk ? 'DNS resolves' : 'DNS check failed'}; ${health.httpsOk ? 'HTTPS responds' : 'HTTPS check failed'}.${health.error ? ` ${health.error}` : ''} Links on this domain may not redirect.`,
          link: `/ntrack/domains/${domain.id}`,
          // At most one alert per domain every 6 hours while it stays down.
          dedupeKey: `domain:${domain.id}`,
          dedupeTtlSeconds: 6 * 3600,
        })
        .catch((error: unknown) => log.error({ err: error, hostname: domain.hostname }, 'domain failure notification failed'));
    }
  }
  // Keep 30 days of check history.
  await prisma.domainHealthCheck.deleteMany({ where: { checkedAt: { lt: new Date(Date.now() - 30 * 86_400_000) } } });
  return domains.length;
};

export const startMaintenance = async (
  connection: ConnectionOptions,
  publisher: ConfigPublisher,
  log: Logger,
  intervals: { configSyncEveryMs: number; domainHealthEveryMs: number },
  clickhouse: ClickHouseClient,
  notifier?: Notifier
) => {
  const queue = new Queue<Record<string, never>, unknown, MaintenanceJob>(MAINTENANCE_QUEUE, { connection });
  // Job schedulers are idempotent upserts, so every worker replica can call this safely and
  // BullMQ still runs each job once per interval across the fleet.
  await queue.upsertJobScheduler('config-sync', { every: intervals.configSyncEveryMs }, { name: 'config-sync' });
  await queue.upsertJobScheduler('domain-health', { every: intervals.domainHealthEveryMs }, { name: 'domain-health' });
  await queue.upsertJobScheduler('session-cleanup', { every: 60 * 60_000 }, { name: 'session-cleanup' });
  await queue.upsertJobScheduler('fraud-scan', { every: 5 * 60_000 }, { name: 'fraud-scan' });
  await queue.upsertJobScheduler('ledger-reconcile', { every: 15 * 60_000 }, { name: 'ledger-reconcile' });
  await queue.upsertJobScheduler('budget-guard', { every: 60_000 }, { name: 'budget-guard' });
  await queue.add('ledger-reconcile', {}, { removeOnComplete: 100, removeOnFail: 500 });
  await queue.add('config-sync', {}, { removeOnComplete: 100, removeOnFail: 500 });

  const worker = new Worker<Record<string, never>, unknown, MaintenanceJob>(
    MAINTENANCE_QUEUE,
    async (job) => {
      switch (job.name) {
        case 'config-sync': {
          const result = await publisher.syncAllSnapshots();
          log.info(result, 'config snapshots synced');
          return result;
        }
        case 'domain-health':
          return { checked: await runDomainHealthChecks(log, notifier) };
        case 'session-cleanup': {
          const { count } = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
          return { removed: count };
        }
        case 'fraud-scan':
          return runFraudScan(clickhouse, log, async (event) => {
            await notifier?.notify({
              organizationId: event.organizationId,
              type: 'fraud.alert',
              title: `Fraud rule triggered (${event.severity})`,
              body: event.reason,
              link: '/ntrack/fraud',
              subject: { publisherId: event.publisherId },
              dedupeKey: `fraud:${event.ruleId}:${event.publisherId ?? 'org'}:${event.campaignId ?? 'all'}`,
              dedupeTtlSeconds: 3600,
            });
          });
        case 'ledger-reconcile':
          return reconcileLedger(log);
        case 'budget-guard':
          return runBudgetGuard(publisher, log, async (campaign) => {
            await notifier?.notify({
              organizationId: campaign.organizationId,
              type: 'budget.exhausted',
              title: `Budget exhausted: ${campaign.name}`,
              body: `${campaign.name} has used its budget. New clicks are recorded as "budget reached" and are not paid until the budget is raised or the month resets.`,
              link: `/ntrack/campaigns/${campaign.campaignId}`,
              subject: { advertiserId: campaign.advertiserId },
            });
          });
        default:
          throw new Error(`Unknown maintenance job ${String(job.name)}`);
      }
    },
    { connection, concurrency: 1 }
  );
  worker.on('failed', (job, error) => log.error({ job: job?.name, err: error }, 'maintenance job failed'));
  return { queue, worker };
};
