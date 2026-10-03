import { pino } from 'pino';

export const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'ntrack-workers' } });
export type Logger = typeof logger;
