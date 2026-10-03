import { z } from 'zod';
import { CURRENCIES } from '@ntrack/shared';
import { amount } from '../campaigns/campaigns.schemas';

const currency = z.enum(CURRENCIES);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const PageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export const CreateInvoiceBody = z
  .object({
    advertiserId: z.string().uuid(),
    periodStart: day,
    periodEnd: day,
    currency,
    taxRate: z.coerce.number().min(0).max(100).default(0),
    notes: z.string().trim().max(2000).default(''),
  })
  .refine((v) => v.periodEnd >= v.periodStart, { path: ['periodEnd'], message: 'End must be on or after start' });

export const ListInvoicesQuery = PageQuery.extend({
  advertiserId: z.string().uuid().optional(),
  status: z.enum(['draft', 'issued', 'paid', 'void']).optional(),
});

export const CreditNoteBody = z.object({ amount, reason: z.string().trim().min(3).max(500) });

export const PaymentBody = z.object({
  advertiserId: z.string().uuid(),
  invoiceId: z.string().uuid().nullish(),
  amount,
  currency,
  method: z.enum(['bank_transfer', 'wire', 'card', 'paypal', 'other']).default('bank_transfer'),
  reference: z.string().trim().max(120).default(''),
  paidAt: day,
  notes: z.string().trim().max(500).default(''),
});

export const ListPaymentsQuery = PageQuery.extend({ direction: z.enum(['incoming', 'outgoing']).optional() });

export const RequestPayoutBody = z.object({ publisherId: z.string().uuid().optional(), currency, notes: z.string().trim().max(500).default('') });

export const ListPayoutsQuery = PageQuery.extend({
  status: z.enum(['requested', 'approved', 'paid', 'rejected']).optional(),
  publisherId: z.string().uuid().optional(),
});

export const RejectPayoutBody = z.object({ reason: z.string().trim().min(3).max(500) });

export const MarkPaidBody = z.object({
  method: z.enum(['bank_transfer', 'wire', 'paypal', 'payoneer', 'other']).default('bank_transfer'),
  reference: z.string().trim().min(1).max(120),
  paidAt: day,
});

export const ExchangeRateBody = z.object({
  currency,
  rateToBase: z.coerce.number().positive().max(1_000_000),
  effectiveDate: day,
});
