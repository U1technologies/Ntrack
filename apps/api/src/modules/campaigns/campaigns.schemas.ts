import { z } from 'zod';
import {
  ATTRIBUTION_MODELS,
  CAMPAIGN_CATEGORIES,
  CONVERSION_EVENTS,
  CURRENCIES,
  DEVICE_TYPES,
  LANGUAGE_CODE_PATTERN,
  PAYOUT_MODELS,
  REFERRER_POLICIES,
  TARGET_BROWSERS,
  TARGET_OPERATING_SYSTEMS,
  TRAFFIC_TYPES,
} from '@ntrack/shared';
import { countryCode, patchSchema } from '../../lib/validate';
import { validateAllowedHost, validateFallbackUrl, validateLandingPageTemplate } from '../../services/destination-validation';

/** Money/rate input: non-negative decimal with up to 6 places, sent as string or number. */
export const amount = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .refine((value) => /^\d{1,12}(\.\d{1,6})?$/.test(value), 'Enter a non-negative amount with up to 6 decimals');

const paramName = z
  .string()
  .trim()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/, 'Use letters, numbers and underscores');

const LandingPageFields = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().trim().min(1).max(2048),
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
});

/** URLs are re-validated in the service against the campaign's HTTPS setting. */
export const UpdateLandingPageBody = patchSchema(LandingPageFields);

export const LandingPageBody = LandingPageFields.superRefine((value, ctx) => {
    // HTTPS is enforced for templates; organizations that allow HTTP destinations still get HTTPS here by default.
    const error = validateLandingPageTemplate(value.url, false);
    if (error) ctx.addIssue({ code: 'custom', path: ['url'], message: error });
  });

const campaignFields = {
  name: z.string().trim().min(2).max(160),
  advertiserId: z.string().uuid(),
  description: z.string().trim().max(5000).default(''),
  vertical: z.string().trim().max(80).default(''),
  category: z.enum(CAMPAIGN_CATEGORIES),
  previewUrl: z.union([z.literal(''), z.string().trim().url().max(2048)]).default(''),
  visibility: z.enum(['public', 'approval_required', 'private']).default('approval_required'),
  startsAt: z.string().datetime().nullish(),
  endsAt: z.string().datetime().nullish(),
  geoAllowed: z.array(countryCode).max(250).default([]),
  geoBlocked: z.array(countryCode).max(250).default([]),
  devices: z.array(z.enum(DEVICE_TYPES)).max(4).default([]),
  // Only values the tracker can detect, so every saved rule is enforced on the click path.
  operatingSystems: z.array(z.enum(TARGET_OPERATING_SYSTEMS)).max(TARGET_OPERATING_SYSTEMS.length).default([]),
  browsers: z.array(z.enum(TARGET_BROWSERS)).max(TARGET_BROWSERS.length).default([]),
  languages: z
    .array(z.string().trim().toLowerCase().regex(LANGUAGE_CODE_PATTERN, 'Use a 2 or 3 letter language code, e.g. en'))
    .max(50)
    .transform((codes) => [...new Set(codes)])
    .default([]),
  allowedTrafficTypes: z.array(z.enum(TRAFFIC_TYPES)).max(20).default([]),
  restrictedTrafficTypes: z.array(z.enum(TRAFFIC_TYPES)).max(20).default([]),
  conversionGoal: z.enum(CONVERSION_EVENTS).default('sale'),
  attributionModel: z.enum(ATTRIBUTION_MODELS).default('last_click'),
  attributionWindowHours: z.number().int().min(1).max(24 * 365).default(720),
  autoApproveConversions: z.boolean().default(false),
  allowMultipleConversions: z.boolean().default(false),
  payoutModel: z.enum(PAYOUT_MODELS).default('CPA'),
  revenueModel: z.enum(PAYOUT_MODELS).default('CPA'),
  currency: z.enum(CURRENCIES).default('USD'),
  defaultRevenue: amount.default('0'),
  defaultPayout: amount.default('0'),
  dailyClickCap: z.number().int().min(1).max(100_000_000).nullish(),
  dailyConversionCap: z.number().int().min(1).max(10_000_000).nullish(),
  monthlyBudget: amount.nullish(),
  totalBudget: amount.nullish(),
  frequencyCap: z.number().int().min(1).max(1000).nullish(),
  redirectMode: z.enum(['standard', 'transparent']).default('standard'),
  destinationParam: paramName.default('url'),
  transparentClickIdParam: z.union([z.literal(''), paramName]).default(''),
  allowDeepLinks: z.boolean().default(false),
  allowedHosts: z
    .array(z.string().trim().toLowerCase().refine(validateAllowedHost, 'Use a hostname like brand.com or *.brand.com'))
    .max(100)
    .default([]),
  requireHttps: z.boolean().default(true),
  fallbackUrl: z
    .string()
    .trim()
    .max(2048)
    .refine((url) => validateFallbackUrl(url) === null, 'Fallback URL must be a valid HTTPS URL')
    .nullish(),
  referrerPolicy: z.enum(REFERRER_POLICIES).nullish(),
  domainIds: z.array(z.string().uuid()).max(50).default([]),
};

const datesInOrder = (value: { startsAt?: string | null; endsAt?: string | null }) =>
  !value.startsAt || !value.endsAt || Date.parse(value.endsAt) > Date.parse(value.startsAt);

const transparentNeedsHosts = (value: { redirectMode?: string; allowedHosts?: string[] }) =>
  value.redirectMode !== 'transparent' || (value.allowedHosts?.length ?? 0) > 0;

export const CreateCampaignBody = z
  .object({
    ...campaignFields,
    status: z.enum(['draft', 'pending', 'active']).default('draft'),
    landingPages: z.array(LandingPageBody).min(1, 'Add at least one landing page').max(50),
  })
  .refine(datesInOrder, { path: ['endsAt'], message: 'End date must be after the start date' })
  .refine(transparentNeedsHosts, { path: ['allowedHosts'], message: 'Transparent redirects need at least one allowed destination host' });

export const UpdateCampaignBody = patchSchema(z.object(campaignFields)).refine(datesInOrder, { path: ['endsAt'], message: 'End date must be after the start date' });

export const ListCampaignsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(100).optional(),
  status: z.enum(['draft', 'pending', 'active', 'paused', 'archived']).optional(),
  advertiserId: z.string().uuid().optional(),
  category: z.enum(CAMPAIGN_CATEGORIES).optional(),
  sort: z.enum(['createdAt', 'name', 'status', 'updatedAt']).default('createdAt'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

export const StatusBody = z.object({ status: z.enum(['active', 'paused', 'archived', 'pending', 'draft']), note: z.string().trim().max(500).default('') });

export const DeleteCampaignBody = z.object({ confirmName: z.string().trim().min(1) });

export const BulkBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), ids: z.array(z.string().uuid()).min(1).max(500), status: z.enum(['active', 'paused', 'archived']) }),
  z.object({
    action: z.literal('update'),
    ids: z.array(z.string().uuid()).min(1).max(500),
    data: z
      .object({
        visibility: z.enum(['public', 'approval_required', 'private']),
        dailyClickCap: z.number().int().min(1).nullable(),
        dailyConversionCap: z.number().int().min(1).nullable(),
        endsAt: z.string().datetime().nullable(),
        category: z.enum(CAMPAIGN_CATEGORIES),
      })
      .partial()
      .refine((data) => Object.keys(data).length > 0, 'Choose at least one field to update'),
  }),
]);

export const PayoutTierBody = z.object({
  name: z.string().trim().max(120).default(''),
  publisherId: z.string().uuid().nullish(),
  trafficSourceId: z.string().uuid().nullish(),
  country: countryCode.nullish(),
  deviceType: z.enum(DEVICE_TYPES).nullish(),
  event: z.enum(CONVERSION_EVENTS).nullish(),
  payout: amount,
  revenue: amount,
  isPercentage: z.boolean().default(false),
  priority: z.number().int().min(0).max(1000).default(0),
  active: z.boolean().default(true),
});

export const UpdatePayoutTierBody = patchSchema(PayoutTierBody);

export const ApplyBody = z.object({ note: z.string().trim().max(1000).default('') });

export const AssignPublisherBody = z.object({
  publisherId: z.string().uuid(),
  status: z.enum(['approved', 'pending', 'rejected', 'blocked']).default('approved'),
  note: z.string().trim().max(500).default(''),
});

export const ApplicationDecisionBody = z.object({
  status: z.enum(['approved', 'rejected', 'blocked', 'pending']),
  note: z.string().trim().max(500).default(''),
});

export const ListApplicationsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  status: z.enum(['pending', 'approved', 'rejected', 'blocked']).optional(),
  campaignId: z.string().uuid().optional(),
  publisherId: z.string().uuid().optional(),
});
