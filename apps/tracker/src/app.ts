import Fastify, { type FastifyInstance } from 'fastify';
import { EMPTY_DATACENTER_MATCHER, type DatacenterMatcher } from '@ntrack/shared';
import type { TrackerConfig } from './config';
import { registerClickRoutes } from './routes/click';
import { registerConversionRoutes } from './routes/conversion';
import { errorPage } from './services/error-page';
import type { TrackerStore } from './services/tracker-store';

export interface TrackerDeps {
  datacenter?: DatacenterMatcher;
}

export const buildTracker = (store: TrackerStore, config: TrackerConfig, deps: TrackerDeps = {}): FastifyInstance => {
  const app = Fastify({
    logger: { level: config.logLevel, redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    exposeHeadRoutes: true,
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 64 },
  });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    reply.removeHeader('X-Powered-By');
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    const ok = await store.ping().catch(() => false);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'unavailable' });
  });
  // Lets the domain health checker confirm a hostname is routed to this tracker.
  app.get('/.well-known/ntrack', async () => ({ service: 'ntrack-tracker' }));

  registerClickRoutes(app, store, config, deps.datacenter ?? EMPTY_DATACENTER_MATCHER);
  registerConversionRoutes(app, store, config);

  app.setNotFoundHandler((_request, reply) => reply.code(404).type('text/html; charset=utf-8').send(errorPage(404)));
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'tracker error');
    return reply.code(503).header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(errorPage(503));
  });
  return app;
};
