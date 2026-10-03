import { z } from 'zod';
import { CURRENCIES, PAYMENT_TERMS } from '@ntrack/shared';
import { countryCode, patchSchema } from '../../lib/validate';

const optionalUrl = z.union([z.literal(''), z.string().trim().url().max(500)]);

export const AdvertiserBody = z.object({
  companyName: z.string().trim().min(2).max(160),
  contactName: z.string().trim().max(120).default(''),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().max(40).default(''),
  website: optionalUrl.default(''),
  country: z.union([z.literal(''), countryCode]).default(''),
  address: z.string().trim().max(500).default(''),
  taxId: z.string().trim().max(60).default(''),
  status: z.enum(['pending', 'active', 'suspended', 'rejected']).default('active'),
  paymentTerms: z.enum(PAYMENT_TERMS).default('NET30'),
  customPaymentDays: z.number().int().min(1).max(365).nullish(),
  currency: z.enum(CURRENCIES).default('USD'),
  notes: z.string().trim().max(2000).default(''),
});

export const UpdateAdvertiserBody = patchSchema(AdvertiserBody);

export const ListAdvertisersQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(100).optional(),
  status: z.enum(['pending', 'active', 'suspended', 'rejected']).optional(),
});
