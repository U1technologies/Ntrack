import { patchSchema } from '../../lib/validate';
import { z } from 'zod';
import { isPermissionKey } from '@ntrack/shared';

const permissionKeys = z.array(z.string().refine(isPermissionKey, 'Unknown permission')).max(200);

export const CreateRoleBody = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).default(''),
  scope: z.enum(['organization', 'advertiser', 'publisher', 'managed']),
  permissions: permissionKeys,
});

export const UpdateRoleBody = patchSchema(CreateRoleBody);
