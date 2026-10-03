import { Router, type Request, type Response } from 'express';
import { created, ok } from '../../lib/response';
import { orgAuth, param, requestMeta } from '../../lib/request';
import { parse } from '../../lib/validate';
import { orgRoute } from '../../middleware/auth';
import type { AppDeps } from '../../types';
import {
  CreateInvoiceBody,
  CreditNoteBody,
  ExchangeRateBody,
  ListInvoicesQuery,
  ListPaymentsQuery,
  ListPayoutsQuery,
  MarkPaidBody,
  PageQuery,
  PaymentBody,
  RejectPayoutBody,
  RequestPayoutBody,
} from './finance.schemas';
import { FinanceService } from './finance.service';

export const createFinanceRouter = (deps: AppDeps) => {
  const router = Router();
  const service = new FinanceService(deps);

  router.get('/overview', ...orgRoute('finance.view'), async (req: Request, res: Response) => ok(res, await service.overview(orgAuth(req))));
  router.get('/balances', ...orgRoute('finance.view'), async (req: Request, res: Response) => ok(res, await service.balances(orgAuth(req))));
  router.get('/journals', ...orgRoute('finance.view'), async (req: Request, res: Response) => ok(res, await service.journals(orgAuth(req), parse(PageQuery, req.query))));

  router.get('/invoices', ...orgRoute('finance.view'), async (req: Request, res: Response) => ok(res, await service.listInvoices(orgAuth(req), parse(ListInvoicesQuery, req.query))));
  router.post('/invoices', ...orgRoute('finance.manage'), async (req: Request, res: Response) =>
    created(res, await service.createInvoice(orgAuth(req), parse(CreateInvoiceBody, req.body), requestMeta(req)), 'Draft invoice created')
  );
  router.get('/invoices/:id', ...orgRoute('finance.view'), async (req: Request, res: Response) => ok(res, await service.getInvoice(orgAuth(req), param(req, 'id'))));
  router.post('/invoices/:id/issue', ...orgRoute('finance.manage'), async (req: Request, res: Response) =>
    ok(res, await service.issueInvoice(orgAuth(req), param(req, 'id'), requestMeta(req)), 'Invoice issued')
  );
  router.post('/invoices/:id/void', ...orgRoute('finance.manage'), async (req: Request, res: Response) =>
    ok(res, await service.voidInvoice(orgAuth(req), param(req, 'id'), requestMeta(req)), 'Invoice voided')
  );
  router.post('/invoices/:id/credit-note', ...orgRoute('finance.manage'), async (req: Request, res: Response) =>
    created(res, await service.creditNote(orgAuth(req), param(req, 'id'), parse(CreditNoteBody, req.body), requestMeta(req)), 'Credit note issued')
  );

  router.get('/payments', ...orgRoute('finance.view'), async (req: Request, res: Response) => ok(res, await service.listPayments(orgAuth(req), parse(ListPaymentsQuery, req.query))));
  router.post('/payments', ...orgRoute('finance.manage'), async (req: Request, res: Response) =>
    created(res, await service.recordPayment(orgAuth(req), parse(PaymentBody, req.body), requestMeta(req)), 'Payment recorded')
  );

  router.get('/payouts', ...orgRoute('finance.view'), async (req: Request, res: Response) => ok(res, await service.listPayouts(orgAuth(req), parse(ListPayoutsQuery, req.query))));
  router.post('/payouts', ...orgRoute('finance.view'), async (req: Request, res: Response) =>
    created(res, await service.requestPayout(orgAuth(req), parse(RequestPayoutBody, req.body), requestMeta(req)), 'Payout requested')
  );
  router.post('/payouts/:id/approve', ...orgRoute('finance.approve'), async (req: Request, res: Response) =>
    ok(res, await service.approvePayout(orgAuth(req), param(req, 'id'), requestMeta(req)), 'Payout approved')
  );
  router.post('/payouts/:id/reject', ...orgRoute('finance.approve'), async (req: Request, res: Response) =>
    ok(res, await service.rejectPayout(orgAuth(req), param(req, 'id'), parse(RejectPayoutBody, req.body).reason, requestMeta(req)), 'Payout rejected')
  );
  router.post('/payouts/:id/mark-paid', ...orgRoute('finance.approve'), async (req: Request, res: Response) =>
    ok(res, await service.markPayoutPaid(orgAuth(req), param(req, 'id'), parse(MarkPaidBody, req.body), requestMeta(req)), 'Payout marked as paid')
  );

  router.get('/exchange-rates', ...orgRoute('finance.view'), async (req: Request, res: Response) => ok(res, await service.listRates(orgAuth(req))));
  router.post('/exchange-rates', ...orgRoute('finance.manage'), async (req: Request, res: Response) =>
    ok(res, await service.saveRate(orgAuth(req), parse(ExchangeRateBody, req.body), requestMeta(req)), 'Exchange rate saved')
  );
  return router;
};
