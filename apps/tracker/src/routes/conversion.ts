import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isClickId, type ConversionIntake } from '@ntrack/shared';
import type { TrackerStore } from '../services/tracker-store';
import { CLICK_COOKIE } from './click';

/**
 * Conversion intake on tracking domains. The tracker only validates and queues; workers do the
 * database work (dedup, payout, attribution, postbacks) so intake stays fast and survives
 * PostgreSQL hiccups.
 *
 *   GET|POST /pb   server-to-server postback, authenticated by the advertiser's postback token
 *   GET      /px   1x1 pixel (click_id parameter or first-party click cookie)
 *   GET      /js/ntrack.js  small script that stores the click ID on landing and fires the pixel
 */

const RESERVED = new Set(['click_id', 'clickid', 'token', 'event', 'goal', 'txn_id', 'transaction_id', 'order_id', 'amount', 'sale_amount', 'currency']);
const MAX_CUSTOM_PARAMS = 20;
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

type Params = Record<string, string>;

const firstValues = (input: unknown): Params => {
  const out: Params = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string' || typeof first === 'number') out[key.toLowerCase()] = String(first).slice(0, 255);
  }
  return out;
};

const readCookie = (request: FastifyRequest, name: string) =>
  (request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? '';

const normalizeEvent = (raw: string | undefined) => {
  const event = (raw ?? 'sale').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40);
  return event || 'sale';
};

const normalizeAmount = (raw: string | undefined): string | null => {
  if (!raw) return null;
  const value = raw.replace(/,/g, '').trim();
  return /^\d{1,12}(\.\d{1,6})?$/.test(value) ? value : null;
};

const buildIntake = (params: Params, clickId: string, source: ConversionIntake['source']): ConversionIntake => ({
  source,
  clickId,
  event: normalizeEvent(params.event ?? params.goal),
  transactionId: (params.txn_id ?? params.transaction_id ?? params.order_id ?? '').slice(0, 120),
  saleAmount: normalizeAmount(params.amount ?? params.sale_amount),
  currency: /^[A-Za-z]{3}$/.test(params.currency ?? '') ? params.currency!.toUpperCase() : '',
  customParams: Object.fromEntries(
    Object.entries(params)
      .filter(([key]) => !RESERVED.has(key) && /^[a-z0-9_]{1,40}$/.test(key))
      .slice(0, MAX_CUSTOM_PARAMS)
  ),
  receivedAt: Date.now(),
});

const tokenMatches = (token: string, expectedHash: string | null) => {
  if (!token || !expectedHash) return false;
  const actual = Buffer.from(createHash('sha256').update(token).digest('hex'));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const reject = (reply: FastifyReply, status: number, reason: string) => reply.code(status).header('Cache-Control', 'no-store').send({ status: 'rejected', reason });

export const registerConversionRoutes = (app: FastifyInstance, store: TrackerStore) => {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16 * 1024 }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  const handlePostback = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = { ...firstValues(request.query), ...firstValues(request.body) };
    const clickId = (params.click_id ?? params.clickid ?? '').toUpperCase();
    if (!isClickId(clickId)) return reject(reply, 400, 'invalid_click_id');

    const context = await store.getClickContext(clickId);
    if (!context) return reject(reply, 404, 'unknown_or_expired_click');
    const advertiser = await store.getAdvertiser(context.advertiserId);
    if (!advertiser || advertiser.organizationId !== context.organizationId || !tokenMatches(params.token ?? '', advertiser.postbackTokenHash)) {
      return reject(reply, 401, 'invalid_token');
    }
    if (!advertiser.active) return reject(reply, 403, 'advertiser_inactive');

    await store.enqueueConversion(buildIntake(params, clickId, 's2s'));
    return reply.code(202).header('Cache-Control', 'no-store').send({ status: 'accepted', click_id: clickId });
  };

  app.get('/pb', { logLevel: 'warn' }, handlePostback);
  app.post('/pb', { logLevel: 'warn' }, handlePostback);

  // Pixels always answer with the GIF so a broken setup never breaks the advertiser's page;
  // rejected conversions are visible in logs and the console instead.
  app.get('/px', { logLevel: 'warn' }, async (request, reply) => {
    const params = firstValues(request.query);
    const clickId = (params.click_id ?? params.clickid ?? readCookie(request, CLICK_COOKIE)).toUpperCase();
    if (isClickId(clickId) && (await store.getClickContext(clickId))) {
      const source = params.src === 'js' ? 'javascript' : 'pixel';
      await store.enqueueConversion(buildIntake(params, clickId, source));
    } else {
      request.log.info({ clickId: clickId.slice(0, 32) }, 'pixel ignored: unknown click');
    }
    return reply
      .header('Content-Type', 'image/gif')
      .header('Cache-Control', 'no-store, max-age=0')
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .send(GIF);
  });

  app.get('/js/ntrack.js', async (request, reply) => {
    const origin = `https://${request.hostname}`;
    return reply.header('Content-Type', 'application/javascript; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send(trackingScript(origin));
  });
};

/**
 * Landing-page script. Stores the click ID from the URL (first-party localStorage on the
 * advertiser's site) and exposes ntrack.convert({ event, txn_id, amount, currency }).
 */
const trackingScript = (origin: string) => `/* NTrack by Nextagmedia conversion tag */
(function (w) {
  var KEY = 'ntrack_click_id', PARAMS = ['ntclid', 'click_id', 'aff_click'];
  try {
    var q = new URLSearchParams(w.location.search);
    for (var i = 0; i < PARAMS.length; i++) { var v = q.get(PARAMS[i]); if (v) { w.localStorage.setItem(KEY, v); break; } }
  } catch (e) {}
  w.ntrack = {
    clickId: function () { try { return w.localStorage.getItem(KEY); } catch (e) { return null; } },
    convert: function (data) {
      data = data || {};
      var q = new URLSearchParams({ src: 'js' });
      var id = this.clickId(); if (id) q.set('click_id', id);
      ['event', 'txn_id', 'amount', 'currency'].forEach(function (k) { if (data[k] != null) q.set(k, String(data[k])); });
      var img = new Image(1, 1); img.referrerPolicy = 'no-referrer'; img.src = '${origin}/px?' + q.toString();
    }
  };
})(window);
`;
