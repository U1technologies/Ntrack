import { z } from 'zod';
import {
  effectiveRedirectResponse,
  normalizeHostname,
  redirectTypeOf,
  safeRequest,
  SafeRequestError,
  REFERRER_POLICIES,
  type RedirectResponse,
  type RedirectType,
} from '@ntrack/shared';
import { AppError } from '../../lib/errors';
import { writeAudit } from '../../services/audit';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';
import { htmlNavigationTarget, inspectHtmlNavigation, type HtmlNavigation } from './html-navigation';

export const RedirectTestBody = z.object({
  trackingUrl: z.string().trim().url().max(4096),
  /** Defaults to the campaign's own destination parameter when the link is found. */
  destinationParam: z
    .string()
    .trim()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/)
    .optional(),
  /** Optional: the final URL the advertiser expects users to land on. */
  expectedFinalUrl: z.string().trim().url().max(4096).optional(),
});

type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CompatibilityCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export type HopKind = 'redirect' | 'html_navigation' | 'final' | 'error';

export interface RedirectHop {
  index: number;
  url: string;
  status: number | null;
  kind: HopKind;
  /** Where this hop sends the browser next (Location header or HTML navigation target). */
  location: string | null;
  latencyMs: number | null;
  https: boolean;
  contentType: string | null;
  referrerPolicyHeader: string | null;
  /** NTrack's own X-NTrack-Response header, when the hop is the tracker. */
  ntrackResponse: string | null;
  html: HtmlNavigation | null;
  error: string | null;
}

export interface RedirectConfiguration {
  found: boolean;
  campaignName: string | null;
  campaignStatus: string | null;
  redirectMode: 'standard' | 'transparent' | null;
  configuredResponse: RedirectResponse | null;
  organizationDefault: RedirectResponse | null;
  effectiveResponse: RedirectResponse | null;
  referrerPolicy: string | null;
  redirectType: RedirectType | null;
  destinationParam: string;
  note: string | null;
}

const MAX_HOPS = 10;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const TESTER_UA = 'NTrack-Compat-Tester/1.0 (+https://nextagmedia.com/ntrack)';
/** Consistency probes use HEAD, which the tracker answers identically but never records as a click. */
const PROBE_AGENTS = {
  browser: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  adsbot: 'AdsBot-Google (+http://www.google.com/adsbot.html)',
};

const header = (value: string | string[] | undefined): string | null => (Array.isArray(value) ? (value[0] ?? null) : (value ?? null));

const sameTarget = (a: string, b: string) => {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
};

/** Same scheme, host and path, with every declared query parameter preserved (extra ones allowed). */
const preservesDeclared = (actual: string, declared: string) => {
  try {
    const a = new URL(actual);
    const d = new URL(declared);
    if (a.origin !== d.origin || a.pathname !== d.pathname) return false;
    return [...d.searchParams.entries()].every(([key, value]) => a.searchParams.getAll(key).includes(value));
  } catch {
    return false;
  }
};

const TYPE_LABELS: Record<RedirectType, string> = {
  '302': '302',
  '302_hide_referrer': '302 with hide referrer',
  '200': '200 OK (HTML page)',
  '200_hide_referrer': '200 OK (HTML page) with hide referrer',
};

/**
 * Technical self-check of the tracker's redirect behaviour for all four redirect types, and of
 * transparent click tracking as Google Ads expects it. It reports observed behaviour only; it does
 * not and cannot grant Google certification, which comes from Google's own review.
 */
/** campaign_id / pub_id may be a serial number (12) or a public ID (cmp_...). */
const refFilter = (value: string | null) => (value && /^[1-9][0-9]{0,8}$/.test(value) ? { number: Number(value) } : { publicId: value ?? '' });

export class RedirectTesterService {
  constructor(private readonly deps: AppDeps) {}

  private allowPrivate(url: string) {
    return this.deps.config.NODE_ENV !== 'production' && new URL(url).hostname.endsWith('.localhost');
  }

  private async walkChain(startUrl: string): Promise<RedirectHop[]> {
    const hops: RedirectHop[] = [];
    let current = startUrl;
    for (let index = 0; index < MAX_HOPS; index += 1) {
      const https = current.startsWith('https://');
      try {
        const response = await safeRequest(current, {
          method: 'GET',
          requireHttps: false,
          timeoutMs: 8000,
          maxBodyBytes: 64 * 1024,
          headers: { 'user-agent': TESTER_UA, accept: 'text/html,*/*' },
          allowPrivateNetwork: this.allowPrivate(current),
        });
        const contentType = header(response.headers['content-type']);
        const rawLocation = header(response.headers.location);
        const base = {
          index,
          url: current,
          status: response.status,
          latencyMs: response.durationMs,
          https,
          contentType,
          referrerPolicyHeader: header(response.headers['referrer-policy']),
          ntrackResponse: header(response.headers['x-ntrack-response']),
          error: null,
        };
        let next: string | null = null;
        if (REDIRECT_CODES.has(response.status) && rawLocation) {
          next = new URL(rawLocation, current).toString();
          hops.push({ ...base, kind: 'redirect', location: next, html: null });
        } else if (response.status === 200 && contentType?.includes('text/html')) {
          const html = inspectHtmlNavigation(response.body, current);
          next = htmlNavigationTarget(html);
          // Only immediate client-side navigation counts as a hop; a normal landing page ends the chain.
          const immediate = next !== null && (html.metaRefreshUrl === null || (html.metaRefreshDelay ?? 0) <= 5);
          hops.push({ ...base, kind: immediate ? 'html_navigation' : 'final', location: immediate ? next : null, html });
          if (!immediate) next = null;
        } else {
          hops.push({ ...base, kind: 'final', location: null, html: null });
        }
        if (!next) break;
        if (hops.some((hop) => hop.url === next)) {
          hops.push({ index: index + 1, url: next, status: null, kind: 'error', location: null, latencyMs: null, https: next.startsWith('https://'), contentType: null, referrerPolicyHeader: null, ntrackResponse: null, html: null, error: 'loop' });
          break;
        }
        current = next;
      } catch (error) {
        const message = error instanceof SafeRequestError ? `${error.code}: ${error.message}` : (error as Error).message;
        hops.push({ index, url: current, status: null, kind: 'error', location: null, latencyMs: null, https, contentType: null, referrerPolicyHeader: null, ntrackResponse: null, html: null, error: message });
        break;
      }
    }
    return hops;
  }

  /** HEAD probes with different user agents: every visitor must get the same answer. */
  private async probeConsistency(url: string) {
    const results: Array<{ agent: string; status: number | null; location: string | null; response: string | null; referrerPolicy: string | null; error: string | null }> = [];
    for (const [agent, ua] of Object.entries(PROBE_AGENTS)) {
      try {
        const response = await safeRequest(url, { method: 'HEAD', requireHttps: false, timeoutMs: 8000, maxBodyBytes: 0, headers: { 'user-agent': ua }, allowPrivateNetwork: this.allowPrivate(url) });
        const location = header(response.headers.location);
        results.push({
          agent,
          status: response.status,
          location: location ? new URL(location, url).toString() : null,
          response: header(response.headers['x-ntrack-response']),
          referrerPolicy: header(response.headers['referrer-policy']),
          error: null,
        });
      } catch (error) {
        results.push({ agent, status: null, location: null, response: null, referrerPolicy: null, error: (error as Error).message });
      }
    }
    return results;
  }

  private async configurationFor(auth: OrgAuthContext, domainId: string, slug: string | null, requestedParam?: string): Promise<RedirectConfiguration> {
    const link = slug
      ? await this.deps.prisma.trackingLink.findFirst({
          where: { slug, domainId, organizationId: auth.organizationId },
          include: { campaign: { select: { name: true, status: true, redirectMode: true, redirectResponse: true, referrerPolicy: true, destinationParam: true } } },
        })
      : null;
    const settings = await this.deps.prisma.organizationSettings.findUnique({ where: { organizationId: auth.organizationId } });
    if (!link) {
      return {
        found: false,
        campaignName: null,
        campaignStatus: null,
        redirectMode: null,
        configuredResponse: null,
        organizationDefault: settings?.redirectResponse ?? null,
        effectiveResponse: null,
        referrerPolicy: null,
        redirectType: null,
        destinationParam: requestedParam ?? 'url',
        note: 'No tracking link with this path on this domain; only observed behaviour is reported.',
      };
    }
    const { campaign } = link;
    const effective = effectiveRedirectResponse(campaign.redirectMode, campaign.redirectResponse, settings?.redirectResponse);
    const policy = (REFERRER_POLICIES as readonly string[]).includes(campaign.referrerPolicy ?? '') ? campaign.referrerPolicy! : (settings?.referrerPolicy ?? 'strict-origin-when-cross-origin');
    const forced = campaign.redirectMode === 'transparent' && (campaign.redirectResponse === 'html_200' || (campaign.redirectResponse === null && settings?.redirectResponse === 'html_200'));
    return {
      found: true,
      campaignName: campaign.name,
      campaignStatus: campaign.status,
      redirectMode: campaign.redirectMode,
      configuredResponse: campaign.redirectResponse,
      organizationDefault: settings?.redirectResponse ?? null,
      effectiveResponse: effective,
      referrerPolicy: policy,
      redirectType: redirectTypeOf(effective, policy),
      destinationParam: requestedParam ?? campaign.destinationParam,
      note:
        campaign.status !== 'active'
          ? `The campaign is ${campaign.status}: visitors go to the fallback URL if one is set, otherwise they see the "offer unavailable" page.`
          : forced
            ? 'The organization default is HTML 200, but transparent (Google Ads) campaigns always use HTTP 302.'
            : null,
    };
  }

  async run(auth: OrgAuthContext, input: z.infer<typeof RedirectTestBody>, meta: RequestMeta) {
    const tracking = new URL(input.trackingUrl);
    const host = normalizeHostname(tracking.hostname);
    const domain = await this.deps.prisma.trackingDomain.findFirst({ where: { organizationId: auth.organizationId, hostname: host } });
    if (!domain) throw AppError.badRequest('The tracking URL must use one of your organization\'s tracking domains');

    const pathSlug = /^\/(?:click|c)\/([0-9A-Za-z]{6,32})\/?$/.exec(tracking.pathname)?.[1] ?? null;
    // Market-style links (/click?campaign_id=&pub_id=) resolve like the tracker: the publisher's oldest active link.
    const marketStyle = !pathSlug && /^\/click\/?$/.test(tracking.pathname) && tracking.searchParams.has('campaign_id') && tracking.searchParams.has('pub_id');
    const slug =
      pathSlug ??
      (marketStyle
        ? ((
            await this.deps.prisma.trackingLink.findFirst({
              where: {
                organizationId: auth.organizationId,
                domainId: domain.id,
                active: true,
                campaign: refFilter(tracking.searchParams.get('campaign_id')),
                publisher: refFilter(tracking.searchParams.get('pub_id')),
              },
              orderBy: { createdAt: 'asc' },
              select: { slug: true },
            })
          )?.slug ?? null)
        : null);
    const config = await this.configurationFor(auth, domain.id, slug, input.destinationParam);
    const forced = tracking.searchParams.get('force_transparent') === 'true' && tracking.searchParams.has(config.destinationParam);
    const transparent = config.redirectMode === 'transparent' || forced || (!config.found && tracking.searchParams.has(config.destinationParam));

    const checks: CompatibilityCheck[] = [];
    const add = (id: string, label: string, status: CheckStatus, detail: string) => checks.push({ id, label, status, detail });

    // 1. Tracking URL format and configuration
    add(
      'url_format',
      'Tracking URL format',
      slug ? 'pass' : 'warn',
      slug
        ? marketStyle
          ? 'Matches https://<domain>/click?campaign_id=<campaign>&pub_id=<publisher>.'
          : 'Matches https://<domain>/click/<link>.'
        : marketStyle
          ? 'No active link for this campaign and publisher on this domain.'
          : `Unexpected path "${tracking.pathname}".`
    );
    add(
      'configuration',
      'Configured redirect type',
      config.found ? 'pass' : 'warn',
      config.found
        ? `${config.campaignName}: ${config.redirectMode} mode, ${TYPE_LABELS[config.redirectType!]} (Referrer-Policy ${config.referrerPolicy}).${config.note ? ` ${config.note}` : ''}`
        : config.note!
    );

    // 2. Declared destination (transparent tracking only)
    const declared = tracking.searchParams.get(config.destinationParam);
    let declaredValid = false;
    if (!transparent) {
      add('destination_param', 'Declared destination parameter', 'skip', 'Standard campaign: the destination comes from the campaign landing page, not the URL.');
      add('destination_visible', 'Destination visibility', 'skip', 'Not a transparent (Google Ads) campaign.');
    } else if (!declared) {
      add('destination_param', 'Declared destination parameter', 'fail', `No "${config.destinationParam}" parameter. Add ?${config.destinationParam}={lpurl} to the tracking template.`);
      add('destination_visible', 'Destination visibility', 'skip', 'No declared destination to inspect.');
    } else if (declared === '{lpurl}') {
      add('destination_param', 'Declared destination parameter', 'warn', 'The ValueTrack placeholder {lpurl} is unexpanded. Test with a real landing page URL in its place.');
      add('destination_visible', 'Destination visibility', 'skip', 'Substitute a real URL to test visibility.');
    } else {
      try {
        const parsed = new URL(declared);
        declaredValid = parsed.protocol === 'https:' || parsed.protocol === 'http:';
        add('destination_param', 'Declared destination parameter', declaredValid ? 'pass' : 'fail', declaredValid ? `"${config.destinationParam}" is present.` : 'The parameter is not an http(s) URL.');
        add('destination_visible', 'Destination visibility', declaredValid ? 'pass' : 'fail', declaredValid ? `Next hop is readable in the URL: ${parsed.href}` : 'The destination is not a plain, readable URL.');
      } catch {
        add('destination_param', 'Declared destination parameter', 'fail', 'The parameter is not a valid absolute URL (it may be double-encoded or obfuscated).');
        add('destination_visible', 'Destination visibility', 'fail', 'A reviewer cannot read the next hop from the tracking URL.');
      }
    }

    // 3. Live behaviour
    const chain = await this.walkChain(input.trackingUrl);
    const first = chain[0];
    const observed: RedirectResponse | null = first?.kind === 'redirect' ? 'redirect_302' : first?.kind === 'html_navigation' ? 'html_200' : null;
    const observedLabel = first?.error
      ? `request failed (${first.error})`
      : first?.kind === 'redirect'
        ? `HTTP ${first.status} redirect`
        : first?.kind === 'html_navigation'
          ? 'HTTP 200 HTML page that navigates to the destination'
          : `HTTP ${first?.status ?? 'n/a'} without a redirect`;
    let responseStatus: CheckStatus = observed ? 'pass' : 'fail';
    let responseDetail = `Observed ${observedLabel}.`;
    if (observed && config.effectiveResponse && observed !== config.effectiveResponse) {
      responseStatus = 'fail';
      responseDetail += ` Expected ${config.effectiveResponse === 'html_200' ? 'an HTML 200 page' : 'an HTTP 302 redirect'}.`;
    } else if (observed === 'redirect_302' && first?.status !== 302 && first?.status !== 301) {
      responseStatus = 'warn';
    }
    add('http_response', 'HTTP response type', responseStatus, responseDetail);

    // Google Ads Help ("About tracking in Google Ads"): "The redirects also need to be server-side." and
    // "The tracking template URL and all redirect URLs need to be HTTPS to work." No status code is named.
    const GOOGLE_SOURCE = 'Source: Google Ads Help, "About tracking in Google Ads".';
    if (transparent) {
      add(
        'google_parallel_tracking',
        'Google Ads parallel tracking',
        observed === 'redirect_302' ? 'pass' : 'fail',
        observed === 'redirect_302'
          ? `Server-side HTTP ${first?.status} redirect. Google Ads requires tracking redirects to be server-side. ${GOOGLE_SOURCE}`
          : `Google Ads requires tracking redirects to be server-side. This link answered with ${observed === 'html_200' ? 'an HTML page (browser-side navigation)' : 'no server-side redirect'}. ${GOOGLE_SOURCE}`
      );
    } else {
      add(
        'google_parallel_tracking',
        'Google Ads parallel tracking',
        observed === 'html_200' ? 'warn' : 'skip',
        observed === 'html_200'
          ? `An HTML 200 page is not a server-side redirect, which Google Ads requires for tracking redirects. Use this link only for non-Google traffic, or use a transparent campaign (NTrack always answers those with 302). ${GOOGLE_SOURCE}`
          : 'Not a transparent campaign. Google Ads tracking templates need a transparent campaign.'
      );
    }

    // Referrer policy (header, and for HTML pages also the meta tag and link rel).
    const expectedPolicy = config.referrerPolicy;
    if (first && !first.error && observed) {
      const headerPolicy = first.referrerPolicyHeader?.toLowerCase() ?? null;
      const metaPolicy = first.html?.metaReferrer ?? null;
      const problems: string[] = [];
      if (expectedPolicy && headerPolicy !== expectedPolicy) problems.push(`header is "${headerPolicy ?? 'missing'}", expected "${expectedPolicy}"`);
      if (first.kind === 'html_navigation' && expectedPolicy && metaPolicy !== expectedPolicy) problems.push(`page meta is "${metaPolicy ?? 'missing'}", expected "${expectedPolicy}"`);
      if (first.kind === 'html_navigation' && expectedPolicy === 'no-referrer' && first.html?.linkRel?.split(/\s+/).includes('noreferrer') !== true) problems.push('the continue link lacks rel="noreferrer"');
      const hide = (headerPolicy ?? metaPolicy) === 'no-referrer';
      add(
        'referrer_policy',
        'Referrer policy',
        problems.length ? 'fail' : 'pass',
        problems.length
          ? `Mismatch: ${problems.join('; ')}.`
          : `Referrer-Policy "${headerPolicy ?? metaPolicy ?? 'not set'}"${first.kind === 'html_navigation' ? ' (header and page meta)' : ''}. ${hide ? 'The destination does not receive the referring page.' : 'The destination receives the referrer as the policy allows.'}`
      );
    } else {
      add('referrer_policy', 'Referrer policy', 'skip', observed ? 'No response to inspect.' : 'The tracker did not redirect, so no referrer policy applies.');
    }

    // HTML page transparency: visible destination, consistent targets, not indexed.
    if (first?.kind === 'html_navigation' && first.html) {
      const nav = first.html;
      const targets = [nav.metaRefreshUrl, nav.scriptUrl, nav.linkUrl].filter((t): t is string => Boolean(t));
      const consistent = targets.length >= 2 && targets.every((t) => sameTarget(t, targets[0]!));
      const indexed = !nav.robots?.toLowerCase().includes('noindex');
      add(
        'html_transparency',
        'HTML page transparency',
        consistent && nav.linkUrl && !indexed ? 'pass' : 'fail',
        consistent && nav.linkUrl && !indexed
          ? `The page shows a visible link to ${nav.linkUrl}; meta refresh, script and link all point to the same destination; marked noindex.`
          : `Issues: ${[!nav.linkUrl && 'no visible destination link', !consistent && 'navigation targets differ or are missing', indexed && 'page is indexable'].filter(Boolean).join(', ')}.`
      );
    }

    // Same answer for every visitor (no cloaking): HEAD probes are not recorded as clicks.
    const probes = await this.probeConsistency(input.trackingUrl);
    // Every click gets its own click ID, which may appear in the destination; compare everything else.
    const withoutClickIds = (url: string | null) => (url ?? '').replace(/[0-9A-HJKMNP-TV-Z]{26}/g, '{click_id}');
    const key = (p: (typeof probes)[number]) => `${p.status}|${withoutClickIds(p.location)}|${p.response ?? ''}|${p.referrerPolicy ?? ''}`;
    const probeOk = probes.every((p) => !p.error) && new Set(probes.map(key)).size === 1;
    add(
      'consistency',
      'Same response for every visitor',
      probeOk ? 'pass' : probes.some((p) => p.error) ? 'warn' : 'fail',
      probeOk
        ? `A browser and Google's AdsBot received the identical response (HTTP ${probes[0]?.status}${probes[0]?.response ? `, ${probes[0].response}` : ''}).`
        : probes.some((p) => p.error)
          ? `Could not complete the probes: ${probes.map((p) => p.error).filter(Boolean).join('; ')}`
          : `Responses differ by user agent: ${probes.map((p) => `${p.agent} → ${key(p)}`).join(' vs ')}.`
    );

    const loop = chain.some((hop) => hop.error === 'loop');
    add('redirect_loop', 'Redirect loops', loop ? 'fail' : 'pass', loop ? 'The chain revisits a URL it already passed through.' : 'No loops detected.');

    const httpHops = chain.filter((hop) => !hop.https);
    const googleHttps = transparent ? ' Google Ads requires the tracking template URL and all redirect URLs to be HTTPS.' : '';
    add('https', 'HTTPS configuration', httpHops.length ? 'fail' : 'pass', httpHops.length ? `Insecure hops: ${httpHops.map((h) => h.url).join(', ')}.${googleHttps}` : `Every hop uses HTTPS.${googleHttps}`);

    const nextHop = first?.location ?? null;
    if (declaredValid && declared && nextHop) {
      if (sameTarget(nextHop, declared)) {
        add('destination_match', 'Destination match', 'pass', 'The tracker sends the visitor to exactly the declared destination.');
      } else if (preservesDeclared(nextHop, declared)) {
        add('destination_match', 'Destination match', 'warn', 'The tracker sends the visitor to the declared page but adds query parameters. Confirm this is acceptable for your ad platform.');
      } else {
        add('destination_match', 'Destination match', 'fail', `Declared ${declared} but the tracker sent the visitor to ${nextHop}.`);
      }
      const declaredIndex = chain.findIndex((hop) => preservesDeclared(hop.url, declared));
      const unexpected = declaredIndex > 1 ? chain.slice(1, declaredIndex) : [];
      add(
        'intermediate_redirects',
        'Unexpected intermediate redirects',
        unexpected.length ? 'fail' : 'pass',
        unexpected.length ? `Hidden hops before the declared destination: ${unexpected.map((h) => h.url).join(' → ')}` : 'No undeclared hops between the tracker and the destination.'
      );
    } else {
      const why = transparent ? 'Needs a valid declared destination and a redirect.' : 'Standard campaign: checked through the final destination instead.';
      add('destination_match', 'Destination match', 'skip', why);
      add('intermediate_redirects', 'Unexpected intermediate redirects', 'skip', why);
    }

    const last = chain[chain.length - 1];
    const finalUrl = last?.error === 'loop' ? null : (last?.url ?? null);
    const finalOk = Boolean(last && !last.error && last.status && last.status < 400);
    let finalDetail = finalOk ? `Landed on ${finalUrl} (HTTP ${last?.status}) after ${chain.length - 1} hop(s).` : `Chain ended with ${last?.error ?? `HTTP ${last?.status}`}.`;
    let finalStatus: CheckStatus = finalOk ? 'pass' : 'fail';
    if (finalOk && input.expectedFinalUrl && finalUrl && !preservesDeclared(finalUrl, input.expectedFinalUrl)) {
      finalStatus = 'warn';
      finalDetail += ` Expected ${input.expectedFinalUrl}.`;
    }
    add('final_destination', 'Final destination', finalStatus, finalDetail);

    const summary = {
      passed: checks.filter((c) => c.status === 'pass').length,
      warnings: checks.filter((c) => c.status === 'warn').length,
      failed: checks.filter((c) => c.status === 'fail').length,
      skipped: checks.filter((c) => c.status === 'skip').length,
    };
    const report = {
      testedAt: new Date().toISOString(),
      trackingUrl: input.trackingUrl,
      destinationParam: config.destinationParam,
      declaredDestination: declared,
      observedResponse: observed,
      configuration: config,
      finalUrl,
      checks,
      chain,
      probes,
      summary,
      verdict: summary.failed > 0 ? 'issues_found' : summary.warnings > 0 ? 'review_warnings' : 'technically_compatible',
      disclaimer:
        'This is an automated technical self-check of redirect behaviour. It is not Google certification or approval. Click tracker certification is granted only by Google after its own review.',
    };
    await writeAudit(this.deps.prisma, auth, meta, { action: 'tool.redirect_test', entityType: 'tracking_domain', entityId: domain.id, summary: `${report.verdict}: ${input.trackingUrl.slice(0, 200)}` });
    return report;
  }
}
