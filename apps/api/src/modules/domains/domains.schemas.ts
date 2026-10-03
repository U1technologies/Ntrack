import { z } from 'zod';
import { isValidHostname, normalizeHostname } from '@ntrack/shared';

export const DOMAIN_PURPOSES = ['affiliate', 'finance', 'travel', 'search', 'advertiser', 'other'] as const;

export const CreateDomainBody = z.object({
  hostname: z
    .string()
    .trim()
    .transform(normalizeHostname)
    .refine(isValidHostname, 'Enter a hostname like click.yourbrand.com (no scheme or path)'),
  purpose: z.enum(DOMAIN_PURPOSES).default('affiliate'),
  advertiserId: z.string().uuid().nullish(),
  isDefault: z.boolean().default(false),
});

export const UpdateDomainBody = z
  .object({
    purpose: z.enum(DOMAIN_PURPOSES),
    advertiserId: z.string().uuid().nullable(),
    isDefault: z.boolean(),
    status: z.enum(['active', 'inactive']),
    domainExpiresAt: z.string().datetime().nullable(),
  })
  .partial();
