import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { apiKeyAuth } from './middleware/api-key';
import { loadSession } from './middleware/auth';
import { csrfProtection } from './middleware/csrf';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { apiRateLimit } from './middleware/rate-limit';
import { createV1Router } from './routes';
import { systemStatus } from './services/system-status';
import type { AppDeps } from './types';

export const createApp = (deps: AppDeps): Express => {
  const app = express();
  app.disable('x-powered-by');
  // Behind Vercel's rewrite proxy and/or a load balancer; needed for correct client IPs.
  app.set('trust proxy', deps.config.TRUST_PROXY ? 2 : false);

  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  if (deps.config.NODE_ENV !== 'test') {
    app.use(pinoHttp({ logger: deps.logger, autoLogging: { ignore: (req) => req.url === '/health' } }));
  }
  // CSV report imports send up to 1,000,000 characters as JSON; escaping can push that past 1 MB.
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.json({ success: true, message: 'ok', data: { service: 'ntrack-api' } });
  });

  // Public status for uptime monitors (reachable as /ntrack/api/status through the website):
  // 200 when database, Redis, ClickHouse, workers and the click queue are healthy, 503 otherwise.
  app.get('/v1/status', async (_req, res, next) => {
    try {
      const status = await systemStatus(deps);
      res.status(status.healthy ? 200 : 503).set('Cache-Control', 'no-store').json({
        success: status.healthy,
        message: status.healthy ? 'All systems operational' : 'Degraded',
        data: { status: status.status, checks: status.checks, checkedAt: status.checkedAt },
      });
    } catch (error) {
      next(error);
    }
  });

  // The console is served from the same site through a rewrite, so no CORS is enabled: other
  // origins cannot call the API with credentials.
  app.use('/v1', apiRateLimit(deps), apiKeyAuth(deps, deps.apiRequestLog), csrfProtection(deps), loadSession(deps), createV1Router(deps));

  app.use(notFoundHandler);
  app.use(errorHandler(deps.logger));
  return app;
};
