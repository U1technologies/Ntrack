import type { Request } from 'express';
import { truncateIp } from '@ntrack/shared';
import type { OrgAuthContext, RequestMeta } from '../types';
import { AppError } from './errors';

/** IP is truncated before it is stored anywhere (sessions, audit logs). */
export const requestMeta = (req: Request): RequestMeta => ({
  ip: truncateIp(req.ip ?? ''),
  userAgent: (req.get('user-agent') ?? '').slice(0, 300),
});

export const orgAuth = (req: Request): OrgAuthContext => {
  const auth = req.auth;
  if (!auth) throw AppError.unauthorized();
  if (!auth.organizationId) throw AppError.badRequest('Select an organization first');
  return auth as OrgAuthContext;
};

export const param = (req: Request, name: string): string => {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) throw AppError.badRequest(`Missing parameter ${name}`);
  return value;
};
