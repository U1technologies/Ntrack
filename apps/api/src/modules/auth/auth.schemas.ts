import { z } from 'zod';

export const password = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(128)
  .refine((value) => /[a-z]/i.test(value) && /\d/.test(value), 'Include letters and numbers');

export const LoginBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
});

export const MfaCodeBody = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') });

export const DisableMfaBody = MfaCodeBody.extend({ password: z.string().min(1).max(128) });

export const SwitchOrganizationBody = z.object({ organizationId: z.string().uuid() });

export const ChangePasswordBody = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password });
