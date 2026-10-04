import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  classifyUserAgent,
  detectBrowser,
  detectDeviceType,
  detectOs,
  generateClickId,
  organizationVisitorId,
  primaryLanguage,
  storeIp,
  visitorFingerprint,
  REDIS_KEYS,
  type ClickContext,
  type ClickEvent,
  type DatacenterMatcher,
} from '@ntrack/shared';
import type { TrackerConfig } from '../config';
import { decideClick } from '../services/click-decision';
import { dayKey } from '../services/day-key';
import { errorPage } from '../services/error-page';
import { buildHtmlRedirect } from '../services/html-redirect';
import { extractRequestFacts, sanitizeReferrer } from '../services/request-facts';
import type { TrackerStore } from '../services/tracker-store';

const SLUG_PATTERN = /^[0-9A-Za-z]{6,32}$/;
export const CLICK_COOKIE = 'ntclk';

const sendError = (reply: FastifyReply, status: number) =>
  reply
    .code(status)
    .header('Cache-Control', 'no-store')
    .header('X-Robots-Tag', 'noindex, nofollow')
    .type('text/html; charset=utf-8')
    .send(errorPage(status));

/** Public click paths: `/click/:slug` is the documented one; `/c/:slug` keeps earlier links working. */
export const CLICK_PATHS = ['/click/:slug', '/c/:slug'] as const;

export const registerClickRoutes = (app: FastifyInstance, store: TrackerStore, config: TrackerConfig, datacenter: DatacenterMatcher) => {
  const handleClick = async (request: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
    const startedAt = performance.now();
    const { slug } = request.params;
    if (!SLUG_PATTERN.test(slug)) return sendError(reply, 404);

    const facts = extractRequestFacts(request, config);
    const hostname = config.devHostOverride && !facts.host.includes('.') ? config.devHostOverride : facts.host;

    const [domain, link] = await store.getDomainAndLink(hostname, slug);
    // Domain isolation: the link must belong to this exact domain and tenant.
    if (!domain || !domain.active || !link || !link.active || link.domainId !== domain.domainId || link.organizationId !== domain.organizationId) {
      return sendError(reply, 404);
    }
    const campaign = await store.getCampaign(link.campaignId);
    if (!campaign || campaign.organizationId !== link.organizationId) return sendError(reply, 404);
    if (campaign.domainIds.length > 0 && !campaign.domainIds.includes(domain.domainId)) return sendError(reply, 404);

    const now = Date.now();
    const clickId = generateClickId(now);
    const deviceType = detectDeviceType(facts.userAgent);
    const fingerprint = visitorFingerprint(facts.ip, facts.userAgent, config.hashSecret);
    const day = dayKey(now, campaign.timezone);
    const capKey = campaign.dailyClickCap ? REDIS_KEYS.dailyClicks(campaign.campaignId, day) : null;
    // HEAD requests (link checkers, previews) get the same answer but are never counted.
    const shouldRecord = request.method === 'GET';

    const [visit, dailyClicks, visitorClicksToday] = await Promise.all([
      shouldRecord
        ? store.markVisit(link.linkId, fingerprint, campaign.uniqueClickWindowHours * 3600, campaign.duplicateClickWindowSeconds)
        : Promise.resolve({ isUnique: false, isDuplicate: false }),
      capKey ? store.getDailyClicks(campaign.campaignId, day) : Promise.resolve(0),
      // HEAD requests never count towards the visitor's frequency cap.
      campaign.frequencyCap && shouldRecord ? store.incrementVisitorFrequency(campaign.campaignId, fingerprint, day) : Promise.resolve(0),
    ]);

    const decision = decideClick(campaign, link, {
      query: facts.query,
      country: facts.country,
      deviceType,
      os: detectOs(facts.userAgent),
      browser: detectBrowser(facts.userAgent),
      language: primaryLanguage(facts.acceptLanguage),
      clickId,
      now,
      botReason: classifyUserAgent(facts.userAgent),
      isDuplicate: visit.isDuplicate,
      isDatacenter: datacenter.matches(facts.ip),
      capReached: campaign.dailyClickCap !== null && dailyClicks >= campaign.dailyClickCap,
      // The counter already includes this click, so the cap is exceeded only above the limit.
      frequencyCapReached: campaign.frequencyCap !== null && visitorClicksToday > campaign.frequencyCap,
    });

    // Defence in depth: config sync already forces 302 for transparent campaigns; check again here.
    const responseType: ClickEvent['responseType'] =
      decision.kind === 'reject' ? 'error' : campaign.redirectMode === 'transparent' ? 'redirect_302' : (campaign.redirectResponse ?? 'redirect_302');
    const httpStatus = decision.kind === 'reject' ? decision.status : responseType === 'html_200' ? 200 : 302;

    const referrer = campaign.collectReferrer ? sanitizeReferrer(facts.referrer) : { url: '', domain: '' };
    const isValid = decision.invalidReason === null;
    const { subs } = decision;
    const q = facts.query;

    const event: ClickEvent = {
      clickId,
      ts: now,
      organizationId: link.organizationId,
      campaignId: campaign.campaignId,
      publisherId: link.publisherId,
      advertiserId: campaign.advertiserId,
      linkId: link.linkId,
      domainId: domain.domainId,
      landingPageId: decision.kind === 'redirect' ? decision.landingPageId : '',
      ...subs,
      externalClickId: decision.externalClickId,
      utmSource: (q.utm_source ?? '').slice(0, 255),
      utmMedium: (q.utm_medium ?? '').slice(0, 255),
      utmCampaign: (q.utm_campaign ?? '').slice(0, 255),
      utmTerm: (q.utm_term ?? '').slice(0, 255),
      utmContent: (q.utm_content ?? '').slice(0, 255),
      country: facts.country,
      region: facts.region,
      city: facts.city,
      deviceType,
      userAgent: facts.userAgent,
      ip: storeIp(facts.ip, campaign.ipStorage, config.hashSecret),
      visitorId: organizationVisitorId(link.organizationId, facts.ip, facts.userAgent, config.hashSecret),
      referrer: referrer.url,
      referrerDomain: referrer.domain,
      destinationUrl: decision.kind === 'redirect' ? decision.location.slice(0, 2048) : '',
      isUnique: visit.isUnique,
      isValid,
      invalidReason: decision.invalidReason ?? '',
      redirectMode: campaign.redirectMode,
      responseType,
      httpStatus,
      referrerPolicy: decision.kind === 'reject' ? '' : campaign.referrerPolicy,
      usedFallback: decision.kind === 'redirect' && decision.usedFallback,
      latencyMs: 0,
    };
    const context: ClickContext = {
      clickId,
      ts: now,
      organizationId: event.organizationId,
      campaignId: event.campaignId,
      publisherId: event.publisherId,
      advertiserId: event.advertiserId,
      linkId: event.linkId,
      domainId: event.domainId,
      ...subs,
      country: event.country,
      deviceType,
      externalClickId: event.externalClickId,
      isValid,
      invalidReason: event.invalidReason,
      visitorId: event.visitorId,
      referrerDomain: event.referrerDomain,
    };

    if (decision.kind === 'reject') {
      event.latencyMs = performance.now() - startedAt;
      if (shouldRecord) store.recordClick(event, context, 3600, null).catch((error) => request.log.error({ err: error, clickId }, 'failed to record click'));
      return sendError(reply, decision.status);
    }

    event.latencyMs = performance.now() - startedAt;
    // Recording happens after the response is queued; a Redis hiccup must never block the redirect.
    reply.raw.once('finish', () => {
      if (!shouldRecord) return;
      store
        .recordClick(event, context, campaign.attributionWindowHours * 3600, isValid ? capKey : null)
        .catch((error) => request.log.error({ err: error, clickId }, 'failed to record click'));
    });

    if (campaign.clickCookieDays > 0 && shouldRecord) {
      // First-party cookie on the tracking domain so a conversion pixel can find the click without
      // a click_id parameter. SameSite=None is required because the pixel loads from the advertiser site.
      reply.header('Set-Cookie', `${CLICK_COOKIE}=${clickId}; Max-Age=${campaign.clickCookieDays * 86_400}; Path=/; Secure; HttpOnly; SameSite=None`);
    }

    reply
      .header('Cache-Control', 'no-store, max-age=0')
      .header('Referrer-Policy', campaign.referrerPolicy)
      .header('X-Robots-Tag', 'noindex, nofollow')
      .header('X-NTrack-Click-Id', clickId)
      .header('X-NTrack-Response', responseType);

    if (responseType === 'html_200') {
      // Same validated destination as the 302 path; only the hand-off to the browser differs.
      const page = buildHtmlRedirect(decision.location, campaign.referrerPolicy);
      return reply.code(200).header('Content-Security-Policy', page.csp).type('text/html; charset=utf-8').send(page.html);
    }
    return reply.code(302).header('Location', decision.location).send();
  };

  // Per-request access logs are off for the click route (volume); errors are still logged.
  for (const path of CLICK_PATHS) app.get<{ Params: { slug: string } }>(path, { logLevel: 'error' }, handleClick);
};
