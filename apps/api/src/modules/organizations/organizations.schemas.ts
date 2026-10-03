import { z } from 'zod';
import { CURRENCIES, REDIRECT_RESPONSES, REFERRER_POLICIES } from '@ntrack/shared';

const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown timezone');

export const CreateOrganizationBody = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/, 'Use lowercase letters, numbers and hyphens'),
  timezone: timezone.default('UTC'),
  currency: z.enum(CURRENCIES).default('USD'),
});

export const UpdateOrganizationBody = z
  .object({ name: z.string().trim().min(2).max(120), timezone, currency: z.enum(CURRENCIES), status: z.enum(['active', 'suspended']) })
  .partial();

const paramName = z.string().trim().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/, 'Use letters, numbers and underscores');

export const UpdateSettingsBody = z
  .object({
    ipStorage: z.enum(['truncated', 'hashed', 'none']),
    collectReferrer: z.boolean(),
    referrerPolicy: z.enum(REFERRER_POLICIES),
    /** Default for standard campaigns; transparent campaigns always use 302. */
    redirectResponse: z.enum(REDIRECT_RESPONSES),
    requireHttpsDestinations: z.boolean(),
    defaultAttributionWindowHours: z.number().int().min(1).max(24 * 365),
    uniqueClickWindowHours: z.number().int().min(1).max(24 * 30),
    duplicateClickWindowSeconds: z.number().int().min(1).max(3600),
    clickRetentionDays: z.number().int().min(30).max(1095),
    mfaRequired: z.boolean(),
    clickCookieDays: z.number().int().min(0).max(90),
    paramMap: z
      .object({
        sub1: paramName,
        sub2: paramName,
        sub3: paramName,
        sub4: paramName,
        sub5: paramName,
        source: paramName,
        externalClickId: paramName,
        landingPage: paramName,
        deepLink: paramName,
      })
      .refine((map) => new Set(Object.values(map)).size === Object.values(map).length, 'Parameter names must be unique'),
  })
  .partial();
