import { z } from 'zod';
import { CURRENCIES, PAYMENT_TERMS, TRAFFIC_TYPES } from '@ntrack/shared';
import { countryCode, patchSchema } from '../../lib/validate';

const optionalUrl = z.union([z.literal(''), z.string().trim().url().max(500)]);

export const TaxInfo = z.object({
  taxId: z.string().trim().max(60).default(''),
  taxCountry: z.union([z.literal(''), countryCode]).default(''),
  legalName: z.string().trim().max(160).default(''),
  vatRegistered: z.boolean().default(false),
});

/** Payout destination. Card numbers are never accepted; bank/PayPal/wire references only. */
export const PaymentDetails = z.object({
  method: z.enum(['bank_transfer', 'wire', 'paypal', 'payoneer', 'other']),
  accountName: z.string().trim().max(160).default(''),
  accountReference: z.string().trim().max(120).default(''),
  bankName: z.string().trim().max(160).default(''),
  swiftOrIfsc: z.string().trim().max(20).default(''),
  paypalEmail: z.union([z.literal(''), z.string().trim().email()]).default(''),
  notes: z.string().trim().max(500).default(''),
});

export const PublisherBody = z.object({
  companyName: z.string().trim().min(2).max(160),
  contactName: z.string().trim().max(120).default(''),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().max(40).default(''),
  website: optionalUrl.default(''),
  country: z.union([z.literal(''), countryCode]).default(''),
  address: z.string().trim().max(500).default(''),
  taxInfo: TaxInfo.nullish(),
  paymentDetails: PaymentDetails.nullish(),
  trafficSources: z.array(z.enum(TRAFFIC_TYPES)).max(20).default([]),
  marketingMethods: z.array(z.string().trim().max(60)).max(20).default([]),
  promotionalChannels: z.array(z.string().trim().max(200)).max(20).default([]),
  monthlyTraffic: z.string().trim().max(60).default(''),
  businessCategory: z.string().trim().max(80).default(''),
  status: z.enum(['pending', 'active', 'suspended', 'rejected']).default('pending'),
  paymentTerms: z.enum(PAYMENT_TERMS).default('NET30'),
  customPaymentDays: z.number().int().min(1).max(365).nullish(),
  currency: z.enum(CURRENCIES).default('USD'),
  notes: z.string().trim().max(2000).default(''),
});

export const UpdatePublisherBody = patchSchema(PublisherBody);

export const PublisherDecisionBody = z.object({
  status: z.enum(['active', 'rejected', 'suspended']),
  note: z.string().trim().max(500).default(''),
});

export const ListPublishersQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(100).optional(),
  status: z.enum(['pending', 'active', 'suspended', 'rejected']).optional(),
});
