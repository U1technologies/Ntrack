import { z } from 'zod';
import type { ScheduledReport } from '@ntrack/db';
import { renderReportEmail } from '@ntrack/notifications';
import type { EmailJob } from '@ntrack/shared';
import { AppError } from '../../lib/errors';
import { toCsv, toXlsx, XLSX_CONTENT_TYPE } from '../../lib/tabular';
import { buildAuthContext } from '../../services/auth-context';
import { writeAudit } from '../../services/audit';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';
import { AnalyticsService, PerformanceReportBody, exportColumns } from '../analytics/analytics.service';
import { isReportDue } from './schedule';

/** Presets that describe a finished period, so a scheduled report never sends a half-day. */
const SCHEDULED_PRESETS = ['yesterday', 'last_7_days', 'last_30_days', 'this_month', 'previous_month'] as const;

const ReportConfig = PerformanceReportBody.omit({ preset: true, from: true, to: true, limit: true }).extend({
  preset: z.enum(SCHEDULED_PRESETS).default('yesterday'),
});

export const ScheduledReportBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    frequency: z.enum(['daily', 'weekly']),
    weekday: z.number().int().min(1).max(7).nullish(),
    hourLocal: z.number().int().min(0).max(23).default(8),
    config: ReportConfig,
    recipients: z.array(z.string().trim().toLowerCase().email()).min(1).max(20),
    active: z.boolean().default(true),
  })
  .refine((value) => value.frequency === 'daily' || value.weekday, { message: 'Choose a weekday for weekly reports', path: ['weekday'] });

export const ScheduledReportPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  frequency: z.enum(['daily', 'weekly']).optional(),
  weekday: z.number().int().min(1).max(7).nullish(),
  hourLocal: z.number().int().min(0).max(23).optional(),
  config: ReportConfig.optional(),
  recipients: z.array(z.string().trim().toLowerCase().email()).min(1).max(20).optional(),
  active: z.boolean().optional(),
});

const MAX_ROWS = 10_000;

export interface RunOutcome {
  sent: number;
  skipped: Array<{ email: string; reason: string }>;
}

/**
 * Scheduled performance reports. Each recipient must be an active member of the organization
 * with `reports.view`, and receives the report generated with *their own* permissions and data
 * scope, so a schedule can never email data its recipient could not see in the console.
 */
export class ScheduledReportsService {
  private readonly analytics: AnalyticsService;

  constructor(private readonly deps: AppDeps) {
    this.analytics = new AnalyticsService(deps);
  }

  private get prisma() {
    return this.deps.prisma;
  }

  async list(auth: OrgAuthContext) {
    return this.prisma.scheduledReport.findMany({ where: { organizationId: auth.organizationId, userId: auth.user.id }, orderBy: { createdAt: 'desc' } });
  }

  private async findOwn(auth: OrgAuthContext, id: string) {
    const report = await this.prisma.scheduledReport.findFirst({ where: { id, organizationId: auth.organizationId, userId: auth.user.id } });
    if (!report) throw AppError.notFound('Scheduled report');
    return report;
  }

  /** Recipients must be members who can view reports; the owner can always receive their own report. */
  private async assertRecipients(auth: OrgAuthContext, recipients: string[]) {
    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId: auth.organizationId, status: 'active', user: { email: { in: recipients }, status: 'active' } },
      include: { user: { select: { email: true } }, role: { select: { permissions: { where: { permissionKey: 'reports.view' }, select: { permissionKey: true } } } } },
    });
    const allowed = new Set(members.filter((m) => m.role.permissions.length > 0).map((m) => m.user.email.toLowerCase()));
    allowed.add(auth.user.email.toLowerCase());
    const invalid = recipients.filter((email) => !allowed.has(email));
    if (invalid.length > 0) throw AppError.badRequest(`These recipients are not members who can view reports: ${invalid.join(', ')}`);
  }

  async create(auth: OrgAuthContext, input: z.infer<typeof ScheduledReportBody>, meta: RequestMeta) {
    await this.assertRecipients(auth, input.recipients);
    const report = await this.prisma.scheduledReport.create({
      data: {
        organizationId: auth.organizationId,
        userId: auth.user.id,
        name: input.name,
        frequency: input.frequency,
        weekday: input.frequency === 'weekly' ? (input.weekday ?? null) : null,
        hourLocal: input.hourLocal,
        config: input.config,
        recipients: [...new Set(input.recipients)],
        active: input.active,
      },
    });
    await writeAudit(this.prisma, auth, meta, { action: 'scheduled_report.created', entityType: 'scheduled_report', entityId: report.id, summary: report.name });
    return report;
  }

  async update(auth: OrgAuthContext, id: string, input: z.infer<typeof ScheduledReportPatch>, meta: RequestMeta) {
    const existing = await this.findOwn(auth, id);
    if (input.recipients) await this.assertRecipients(auth, input.recipients);
    const frequency = input.frequency ?? existing.frequency;
    const weekday = input.weekday !== undefined ? input.weekday : existing.weekday;
    if (frequency === 'weekly' && !weekday) throw AppError.badRequest('Choose a weekday for weekly reports');
    const report = await this.prisma.scheduledReport.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.hourLocal !== undefined ? { hourLocal: input.hourLocal } : {}),
        ...(input.config !== undefined ? { config: input.config } : {}),
        ...(input.recipients !== undefined ? { recipients: [...new Set(input.recipients)] } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        frequency,
        weekday: frequency === 'weekly' ? weekday : null,
      },
    });
    await writeAudit(this.prisma, auth, meta, { action: 'scheduled_report.updated', entityType: 'scheduled_report', entityId: id, summary: report.name });
    return report;
  }

  async remove(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    const report = await this.findOwn(auth, id);
    await this.prisma.scheduledReport.delete({ where: { id } });
    await writeAudit(this.prisma, auth, meta, { action: 'scheduled_report.deleted', entityType: 'scheduled_report', entityId: id, summary: report.name });
    return { id };
  }

  async runNow(auth: OrgAuthContext, id: string) {
    return this.run(await this.findOwn(auth, id));
  }

  /** Called by the scheduler; returns how many reports ran. */
  async runDue(now = new Date()): Promise<number> {
    const reports = await this.prisma.scheduledReport.findMany({ where: { active: true }, include: { organization: { select: { timezone: true, status: true } } } });
    let ran = 0;
    for (const report of reports) {
      if (report.organization.status !== 'active') continue;
      const spec = { frequency: report.frequency === 'weekly' ? ('weekly' as const) : ('daily' as const), weekday: report.weekday, hourLocal: report.hourLocal, lastRunAt: report.lastRunAt };
      if (!isReportDue(spec, report.organization.timezone, now)) continue;
      await this.run(report).catch((error: unknown) => this.deps.logger.error({ err: error, reportId: report.id }, 'scheduled report failed'));
      ran += 1;
    }
    return ran;
  }

  /** Builds the auth context a member would have in the console, for generating their copy. */
  private async contextFor(organizationId: string, email: string): Promise<OrgAuthContext | null> {
    const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true, email: true, name: true, isPlatformAdmin: true, mfaEnabled: true, status: true } });
    if (!user || user.status !== 'active') return null;
    const context = await buildAuthContext(this.prisma, { id: 'scheduled-report', mfaVerified: true, activeOrganizationId: organizationId, user });
    if (context.organizationId !== organizationId || !context.permissions.has('reports.view')) return null;
    return context as OrgAuthContext;
  }

  private async run(report: ScheduledReport): Promise<RunOutcome> {
    const outcome: RunOutcome = { sent: 0, skipped: [] };
    try {
      const owner = await this.contextFor(report.organizationId, (await this.prisma.user.findUniqueOrThrow({ where: { id: report.userId } })).email);
      if (!owner || !owner.permissions.has('reports.schedule')) throw new Error('The owner no longer has permission to schedule reports');
      const config = ReportConfig.parse(report.config);
      const jobs: Array<{ name: string; data: EmailJob }> = [];
      for (const email of report.recipients) {
        const context = await this.contextFor(report.organizationId, email);
        if (!context) {
          outcome.skipped.push({ email, reason: 'not an active member who can view reports' });
          continue;
        }
        const result = await this.analytics.performanceReport(context, { ...config, limit: MAX_ROWS });
        const columns = exportColumns(result.dimensions, result.metrics);
        const base = `ntrack-${report.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${result.range.fromDay}-${result.range.toDay}`;
        const rangeLabel = result.range.fromDay === result.range.toDay ? result.range.fromDay : `${result.range.fromDay} to ${result.range.toDay}`;
        jobs.push({
          name: 'scheduled-report',
          data: {
            to: email,
            ...renderReportEmail({ reportName: report.name, rangeLabel, rowCount: result.rows.length }),
            attachments: [
              { filename: `${base}.csv`, contentType: 'text/csv', contentBase64: Buffer.from(toCsv(result.rows, columns)).toString('base64') },
              { filename: `${base}.xlsx`, contentType: XLSX_CONTENT_TYPE, contentBase64: (await toXlsx(result.rows, columns, report.name)).toString('base64') },
            ],
          },
        });
      }
      if (jobs.length > 0) {
        await this.deps.emailQueue.addBulk(jobs.map((job) => ({ ...job, opts: { attempts: 5, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: 200, removeOnFail: 1000 } })));
      }
      outcome.sent = jobs.length;
      const emailNote = this.deps.config.SMTP_HOST ? '' : ' (email is not configured; nothing was delivered)';
      await this.prisma.scheduledReport.update({
        where: { id: report.id },
        data: { lastRunAt: new Date(), lastStatus: `queued ${jobs.length} email(s)${outcome.skipped.length ? `, skipped ${outcome.skipped.length}` : ''}${emailNote}`.slice(0, 250) },
      });
      return outcome;
    } catch (error) {
      const message = (error as Error).message.slice(0, 200);
      // lastRunAt is still set so a broken report does not retry every few minutes.
      await this.prisma.scheduledReport.update({ where: { id: report.id }, data: { lastRunAt: new Date(), lastStatus: `failed: ${message}` } });
      await this.deps.notifier.notify({
        organizationId: report.organizationId,
        type: 'report.failed',
        title: `Scheduled report failed: ${report.name}`,
        body: message,
        link: '/ntrack/reports/scheduled',
        onlyUserIds: [report.userId],
      });
      throw error;
    }
  }
}
