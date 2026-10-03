import { pino } from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'ntrack-api' },
  redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', '*.password', '*.passwordHash'],
});
export type Logger = typeof logger;
