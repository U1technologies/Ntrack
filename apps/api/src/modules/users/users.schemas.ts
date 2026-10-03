import { z } from 'zod';
import { password } from '../auth/auth.schemas';

export const ListMembersQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(100).optional(),
  roleId: z.string().uuid().optional(),
  status: z.enum(['active', 'invited', 'disabled']).optional(),
});

export const CreateMemberBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(120),
  roleId: z.string().uuid(),
  /** Initial password, required only when the email is new to NTrack. Share it securely; the user should change it. */
  password: password.optional(),
  advertiserId: z.string().uuid().nullish(),
  publisherId: z.string().uuid().nullish(),
});

export const UpdateMemberBody = z
  .object({
    roleId: z.string().uuid(),
    status: z.enum(['active', 'disabled']),
    advertiserId: z.string().uuid().nullable(),
    publisherId: z.string().uuid().nullable(),
  })
  .partial();

export const AssignmentsBody = z.object({
  advertiserIds: z.array(z.string().uuid()).max(500).default([]),
  publisherIds: z.array(z.string().uuid()).max(500).default([]),
});

export const ResetPasswordBody = z.object({ password });
