import { z } from 'zod';
import { normalizeHostname, safeRequest, SafeRequestError } from '@ntrack/shared';
import { AppError } from '../../lib/errors';
import { writeAudit } from '../../services/audit';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';

export const RedirectTestBody = z.object({
  trackingUrl: z.string().trim().url().max(4096),
  destinationParam: z
    .string()
    .trim()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/)
    .default('url'),
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

export interface RedirectHop {
  index: number;
  url: string;
  status: number | null;
  location: string | null;
  latencyMs: number | null;
  https: boolean;
  error: string | null;
}

const MAX_HOPS = 10;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const TESTER_UA = 'NTrack-Compat-Tester/1.0 (+https://nextagmedia.com/ntrack)';

const sameTarget = (a: string, b: string) => {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.href === right.href;
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

/**
 * Technical self-check for transparent click tracking (the behaviour Google Ads expects from
 * third-party click trackers). It reports observed behaviour only; it does not and cannot grant
 * Google certification, which comes from Google's own review.
 */
export class RedirectTesterService {
  constructor(private readonly deps: AppDeps) {}

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
          maxBodyBytes: 8 * 1024,
          headers: { 'user-agent': TESTER_UA, accept: 'text/html,*/*' },
          allowPrivateNetwork: this.deps.config.NODE_ENV !== 'production' && new URL(current).hostname.endsWith('.localhost'),
        });
        const rawLocation = typeof response.headers.location === 'string' ? response.headers.location : null;
        const location = rawLocation ? new URL(rawLocation, current).toString() : null;
        hops.push({ index, url: current, status: response.status, location, latencyMs: response.durationMs, https, error: null });
        if (!REDIRECT_CODES.has(response.status) || !location) break;
        if (hops.some((hop) => hop.url === location)) {
          hops.push({ index: index + 1, url: location, status: null, location: null, latencyMs: null, https: location.startsWith('https://'), error: 'loop' });
          break;
        }
        current = location;
      } catch (error) {
        const message = error instanceof SafeRequestError ? `${error.code}: ${error.message}` : (error as Error).message;
        hops.push({ index, url: current, status: null, location: null, latencyMs: null, https, error: message });
        break;
      }
    }
    return hops;
  }

  async run(auth: OrgAuthContext, input: z.infer<typeof RedirectTestBody>, meta: RequestMeta) {
    const tracking = new URL(input.trackingUrl);
    const host = normalizeHostname(tracking.hostname);
    const domain = await this.deps.prisma.trackingDomain.findFirst({ where: { organizationId: auth.organizationId, hostname: host } });
    if (!domain) throw AppError.badRequest('The tracking URL must use one of your organization\'s tracking domains');

    const checks: CompatibilityCheck[] = [];
    const add = (id: string, label: string, status: CheckStatus, detail: string) => checks.push({ id, label, status, detail });

    // 1. Tracking URL format
    const isNTrackPath = /^\/c\/[0-9A-Za-z]{6,32}\/?$/.test(tracking.pathname);
    add('url_format', 'Tracking URL format', isNTrackPath ? 'pass' : 'warn', isNTrackPath ? 'Matches https://<domain>/c/<link>.' : `Unexpected path "${tracking.pathname}".`);

    // 2/3. Destination parameter and visibility
    const declared = tracking.searchParams.get(input.destinationParam);
    let declaredValid = false;
    if (!declared) {
      add('destination_param', 'Required destination parameter', 'fail', `No "${input.destinationParam}" parameter. Add ?${input.destinationParam}={lpurl} to the tracking template.`);
      add('destination_visible', 'Destination visibility', 'skip', 'No declared destination to inspect.');
    } else if (declared === '{lpurl}') {
      add('destination_param', 'Required destination parameter', 'warn', 'The ValueTrack placeholder {lpurl} is unexpanded. Test with a real landing page URL in its place.');
      add('destination_visible', 'Destination visibility', 'skip', 'Substitute a real URL to test visibility.');
    } else {
      try {
        const parsed = new URL(declared);
        declaredValid = parsed.protocol === 'https:' || parsed.protocol === 'http:';
        add('destination_param', 'Required destination parameter', declaredValid ? 'pass' : 'fail', declaredValid ? `"${input.destinationParam}" is present.` : 'The parameter is not an http(s) URL.');
        add('destination_visible', 'Destination visibility', declaredValid ? 'pass' : 'fail', declaredValid ? `Next hop is readable in the URL: ${parsed.href}` : 'The destination is not a plain, readable URL.');
      } catch {
        add('destination_param', 'Required destination parameter', 'fail', 'The parameter is not a valid absolute URL (it may be double-encoded or obfuscated).');
        add('destination_visible', 'Destination visibility', 'fail', 'A reviewer cannot read the next hop from the tracking URL.');
      }
    }

    // 4-10. Live behaviour
    const chain = await this.walkChain(input.trackingUrl);
    const first = chain[0];
    const firstIsRedirect = Boolean(first?.status && REDIRECT_CODES.has(first.status));
    add(
      'http_response',
      'HTTP response behaviour',
      first?.error ? 'fail' : firstIsRedirect ? (first?.status === 302 || first?.status === 301 ? 'pass' : 'warn') : 'fail',
      first?.error ? `Request failed: ${first.error}` : firstIsRedirect ? `Tracker answered HTTP ${first?.status} with a Location header.` : `Tracker answered HTTP ${first?.status ?? 'n/a'} instead of a redirect.`
    );

    const loop = chain.some((hop) => hop.error === 'loop');
    add('redirect_loop', 'Redirect loops', loop ? 'fail' : 'pass', loop ? 'The chain revisits a URL it already passed through.' : 'No loops detected.');

    const httpHops = chain.filter((hop) => !hop.https);
    add('https', 'HTTPS configuration', httpHops.length ? 'fail' : 'pass', httpHops.length ? `Insecure hops: ${httpHops.map((h) => h.url).join(', ')}` : 'Every hop uses HTTPS.');

    const nextHop = first?.location ?? null;
    if (declaredValid && declared && nextHop) {
      if (sameTarget(nextHop, declared)) {
        add('destination_match', 'Destination match', 'pass', 'The tracker redirects to exactly the declared destination.');
      } else if (preservesDeclared(nextHop, declared)) {
        add('destination_match', 'Destination match', 'warn', 'The tracker redirects to the declared page but adds query parameters. Confirm this is acceptable for your ad platform.');
      } else {
        add('destination_match', 'Destination match', 'fail', `Declared ${declared} but the tracker redirected to ${nextHop}.`);
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
      add('destination_match', 'Destination match', 'skip', 'Needs a valid declared destination and a redirect.');
      add('intermediate_redirects', 'Unexpected intermediate redirects', 'skip', 'Needs a valid declared destination and a redirect.');
    }

    const last = chain[chain.length - 1];
    const finalUrl = last?.error === 'loop' ? null : (last?.url ?? null);
    const finalOk = Boolean(last && !last.error && last.status && last.status < 400);
    let finalDetail = finalOk ? `Landed on ${finalUrl} (HTTP ${last?.status}).` : `Chain ended with ${last?.error ?? `HTTP ${last?.status}`}.`;
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
      destinationParam: input.destinationParam,
      declaredDestination: declared,
      finalUrl,
      checks,
      chain,
      summary,
      verdict: summary.failed > 0 ? 'issues_found' : summary.warnings > 0 ? 'review_warnings' : 'technically_compatible',
      disclaimer:
        'This is an automated technical self-check of redirect behaviour. It is not Google certification or approval. Click tracker certification is granted only by Google after its own review.',
    };
    await writeAudit(this.deps.prisma, auth, meta, { action: 'tool.redirect_test', entityType: 'tracking_domain', entityId: domain.id, summary: `${report.verdict}: ${input.trackingUrl.slice(0, 200)}` });
    return report;
  }
}
