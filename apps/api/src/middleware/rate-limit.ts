import { ipKeyGenerator, rateLimit, type Options } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import type { AppDeps } from '../types';

const handler: Options['handler'] = (_req, res) =>
  res.status(429).json({ success: false, message: 'Too many requests. Please slow down and try again shortly.', data: null });

/** Redis-backed so limits hold across API replicas. */
const store = ({ redis }: AppDeps, prefix: string) =>
  new RedisStore({
    prefix: `ntrack:rl:${prefix}:`,
    sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as Promise<RedisReply>,
  });

export const apiRateLimit = (deps: AppDeps) =>
  rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false, store: store(deps, 'api'), handler });

export const loginRateLimit = (deps: AppDeps) =>
  rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: store(deps, 'login'),
    handler,
    // ipKeyGenerator groups IPv6 addresses by /56 so rotating addresses inside one allocation cannot bypass the limit.
    keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}:${String(req.body?.email ?? '').toLowerCase().slice(0, 254)}`,
  });

export const toolRateLimit = (deps: AppDeps) =>
  rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, store: store(deps, 'tools'), handler });

/** Forgot-password requests: per IP and email, so one address cannot be flooded with emails. */
export const passwordResetRequestLimit = (deps: AppDeps) =>
  rateLimit({
    windowMs: 60 * 60_000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: store(deps, 'pwreset'),
    handler,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}:${String(req.body?.email ?? '').toLowerCase().slice(0, 254)}`,
  });

/** Using invitation and reset links (token guessing protection; tokens are 256-bit anyway). */
export const accountTokenLimit = (deps: AppDeps) =>
  rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, store: store(deps, 'acctoken'), handler, keyGenerator: (req) => ipKeyGenerator(req.ip ?? '') });
