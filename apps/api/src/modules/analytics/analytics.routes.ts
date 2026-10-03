import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { DateRangeQuery } from '../../lib/date-range';
import { toCsv, toXlsx, XLSX_CONTENT_TYPE } from '../../lib/tabular';
import { ok } from '../../lib/response';
import { orgAuth } from '../../lib/request';
import { parse } from '../../lib/validate';
import { orgRoute } from '../../middleware/auth';
import type { AppDeps } from '../../types';
import { AnalyticsService, ClickLogQuery, ClickReportBody, PerformanceReportBody, exportColumns } from './analytics.service';

const ExportFormat = z.object({ format: z.enum(['csv', 'xlsx']).default('csv') });

const sendTable = async (res: Response, format: 'csv' | 'xlsx', filename: string, rows: Record<string, unknown>[], columns: string[]) => {
  if (format === 'xlsx') {
    res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    res.send(await toXlsx(rows, columns));
    return;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  res.send(toCsv(rows, columns));
};

export const createAnalyticsRouter = (deps: AppDeps) => {
  const router = Router();
  const service = new AnalyticsService(deps);

  router.get('/dashboard', ...orgRoute(['reports.view', 'clicks.view']), async (req: Request, res: Response) =>
    ok(res, await service.dashboard(orgAuth(req), parse(DateRangeQuery, req.query)))
  );
  router.get('/clicks', ...orgRoute('clicks.view'), async (req: Request, res: Response) => ok(res, await service.clickLog(orgAuth(req), parse(ClickLogQuery, req.query))));
  router.post('/reports/clicks', ...orgRoute('reports.view'), async (req: Request, res: Response) =>
    ok(res, await service.clickReport(orgAuth(req), parse(ClickReportBody, req.body)))
  );
  router.post('/reports/clicks/export', ...orgRoute('reports.export'), async (req: Request, res: Response) => {
    const body = parse(ClickReportBody, req.body);
    const { format } = parse(ExportFormat, req.query);
    const report = await service.clickReport(orgAuth(req), { ...body, limit: 10_000, offset: 0 });
    await sendTable(res, format, `ntrack-click-report-${report.range.fromDay}-${report.range.toDay}`, report.rows, exportColumns(report.dimensions, report.metrics));
  });
  router.post('/reports/performance', ...orgRoute('reports.view'), async (req: Request, res: Response) =>
    ok(res, await service.performanceReport(orgAuth(req), parse(PerformanceReportBody, req.body)))
  );
  router.post('/reports/performance/export', ...orgRoute('reports.export'), async (req: Request, res: Response) => {
    const body = parse(PerformanceReportBody, req.body);
    const { format } = parse(ExportFormat, req.query);
    const report = await service.performanceReport(orgAuth(req), { ...body, limit: 10_000 });
    await sendTable(res, format, `ntrack-performance-${report.range.fromDay}-${report.range.toDay}`, report.rows, exportColumns(report.dimensions, report.metrics));
  });
  return router;
};
