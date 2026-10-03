import { z } from 'zod';

const subValue = z.string().trim().max(255).default('');
const paramKey = z.string().trim().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/, 'Parameter names may use letters, numbers, _ . -');

export const LinkConfig = z.object({
  campaignId: z.string().uuid(),
  publisherId: z.string().uuid().optional(),
  domainId: z.string().uuid(),
  landingPageId: z.string().uuid().nullish(),
  name: z.string().trim().max(120).default(''),
  sub1: subValue,
  sub2: subValue,
  sub3: subValue,
  sub4: subValue,
  sub5: subValue,
  source: subValue,
  utm: z
    .object({ utm_source: subValue, utm_medium: subValue, utm_campaign: subValue, utm_term: subValue, utm_content: subValue })
    .partial()
    .default({}),
  customParams: z.record(paramKey, z.string().trim().max(255)).default({}),
});

export const CreateLinkBody = LinkConfig;

export const BulkLinksBody = z.object({
  campaignId: z.string().uuid(),
  domainId: z.string().uuid(),
  landingPageId: z.string().uuid().nullish(),
  utm: LinkConfig.shape.utm,
  customParams: LinkConfig.shape.customParams,
  rows: z
    .array(
      z.object({
        publisherId: z.string().uuid().optional(),
        name: z.string().trim().max(120).default(''),
        sub1: subValue,
        sub2: subValue,
        sub3: subValue,
        sub4: subValue,
        sub5: subValue,
        source: subValue,
      })
    )
    .min(1)
    .max(500),
});

export const UpdateLinkBody = z
  .object({ name: z.string().trim().max(120), active: z.boolean(), landingPageId: z.string().uuid().nullable() })
  .partial();

export const ListLinksQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(100).optional(),
  campaignId: z.string().uuid().optional(),
  publisherId: z.string().uuid().optional(),
  domainId: z.string().uuid().optional(),
  active: z.enum(['true', 'false']).optional(),
});

export const TemplateBody = z.object({
  name: z.string().trim().min(1).max(80),
  config: LinkConfig.partial(),
});
