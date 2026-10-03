import { patchSchema } from '../../lib/validate';
import { z } from 'zod';
import { POSTBACK_EVENTS, parseTemplate, validateJsonTemplate } from '@ntrack/shared';

const urlTemplate = z
  .string()
  .trim()
  .min(8)
  .max(2048)
  .superRefine((value, ctx) => {
    const parsed = parseTemplate(value, 'postback');
    if (parsed.errors.length) return ctx.addIssue({ code: 'custom', message: parsed.errors.join(' ') });
    const authorityEnd = value.indexOf('/', value.indexOf('//') + 2);
    if ((authorityEnd === -1 ? value : value.slice(0, authorityEnd)).includes('{')) ctx.addIssue({ code: 'custom', message: 'Macros are not allowed in the hostname' });
  });

const headerName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const RESERVED_HEADERS = /^(host|content-length|authorization|x-ntrack-.*)$/i;

export const PostbackBody = z.object({
  name: z.string().trim().min(2).max(120),
  publisherId: z.string().uuid().nullish(),
  campaignId: z.string().uuid().nullish(),
  events: z.array(z.enum(POSTBACK_EVENTS)).min(1),
  method: z.enum(['GET', 'POST']).default('GET'),
  urlTemplate,
  bodyTemplate: z
    .record(z.string(), z.unknown())
    .nullish()
    .superRefine((value, ctx) => {
      if (!value) return;
      const errors = validateJsonTemplate(value);
      if (errors.length) ctx.addIssue({ code: 'custom', message: errors.join(' ') });
    }),
  headers: z
    .record(headerName, z.string().max(500))
    .default({})
    .refine((h) => Object.keys(h).every((k) => !RESERVED_HEADERS.test(k)), 'Authorization and X-NTrack-* headers are set by NTrack'),
  /** Write-only secrets: send a value to set, null to clear, omit to keep. */
  authToken: z.string().min(8).max(500).nullish(),
  hmacSecret: z.string().min(16).max(500).nullish(),
  active: z.boolean().default(true),
});

export const UpdatePostbackBody = patchSchema(PostbackBody);

export const ListDeliveriesQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  postbackId: z.string().uuid().optional(),
  status: z.enum(['pending', 'success', 'failed', 'retrying']).optional(),
});
