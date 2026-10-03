import { z } from 'zod';
import { ATTRIBUTION_MODELS, CONVERSION_EVENTS } from '@ntrack/shared';
import { DateRangeQuery } from '../../lib/date-range';
import { amount } from '../campaigns/campaigns.schemas';

export const ListConversionsQuery = DateRangeQuery.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(['pending', 'approved', 'rejected', 'reversed']).optional(),
  campaignId: z.string().uuid().optional(),
  publisherId: z.string().uuid().optional(),
  advertiserId: z.string().uuid().optional(),
  event: z.string().max(40).optional(),
  source: z.enum(['s2s', 'pixel', 'javascript', 'api', 'manual']).optional(),
  search: z.string().trim().max(120).optional(),
});

export const CreateConversionBody = z.object({
  clickId: z.string().trim().toUpperCase().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'Enter a valid NTrack click ID'),
  event: z.enum(CONVERSION_EVENTS).default('sale'),
  transactionId: z.string().trim().max(120).default(''),
  saleAmount: amount.nullish(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  note: z.string().trim().max(500).default(''),
});

export const StatusChangeBody = z.object({
  status: z.enum(['approved', 'rejected', 'reversed', 'pending']),
  note: z.string().trim().max(500).default(''),
});

export const BulkStatusBody = StatusChangeBody.extend({ ids: z.array(z.string().uuid()).min(1).max(500) });

export const AdjustBody = z
  .object({ payout: amount.optional(), revenue: amount.optional(), saleAmount: amount.optional(), note: z.string().trim().min(3, 'Explain the adjustment').max(500) })
  .refine((v) => v.payout !== undefined || v.revenue !== undefined || v.saleAmount !== undefined, 'Change at least one amount');

export const RecalculateBody = z.object({ model: z.enum(ATTRIBUTION_MODELS) });
