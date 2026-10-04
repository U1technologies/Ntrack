import {
  renderTemplate,
  targetingMismatch,
  validateDestinationUrl,
  type CampaignSnapshot,
  type DeviceType,
  type InvalidClickReason,
  type LinkSnapshot,
  type MacroValues,
  type TargetBrowser,
  type TargetOperatingSystem,
} from '@ntrack/shared';

/**
 * Pure redirect decision. Given the config snapshots and request facts, decide whether to
 * redirect, where to, and how to classify the click. No I/O happens here, which keeps the
 * open-redirect and transparency rules exhaustively unit-testable.
 *
 * Transparency rules enforced here:
 *  - The destination is always a declared one: a campaign landing page, an allowlisted deep link,
 *    or (transparent mode) the URL visible in the tracking request's destination parameter.
 *  - In transparent mode the tracker never substitutes a different destination: an invalid or
 *    missing declared destination is an error, not a silent fallback.
 *  - Every final URL is re-validated after macro rendering.
 */

export type RejectCode = 'link_not_found' | 'campaign_unavailable' | 'destination_invalid' | 'destination_missing';

export interface ClickFacts {
  query: Record<string, string>;
  country: string;
  deviceType: DeviceType;
  os: TargetOperatingSystem;
  browser: TargetBrowser;
  /** Primary Accept-Language subtag, '' when absent. */
  language: string;
  clickId: string;
  now: number;
  /** Set when the user agent looks automated; recorded but still redirected. */
  botReason: InvalidClickReason | null;
  isDuplicate: boolean;
  /** Request IP is in a published cloud provider range; flagged, never blocked. */
  isDatacenter: boolean;
  capReached: boolean;
  frequencyCapReached: boolean;
}

export interface ClickSubs {
  sub1: string;
  sub2: string;
  sub3: string;
  sub4: string;
  sub5: string;
  source: string;
  gaid: string;
  idfa: string;
  appName: string;
}

interface DecisionAttribution {
  subs: ClickSubs;
  externalClickId: string;
}

export type ClickDecision = DecisionAttribution &
  (
    | {
        kind: 'redirect';
        location: string;
        landingPageId: string;
        /** True when the user is sent to the campaign fallback instead of the offer. */
        usedFallback: boolean;
        /** The destination came from the transparency parameter (transparent campaign or force_transparent=true). */
        transparent?: boolean;
        invalidReason: InvalidClickReason | null;
      }
    | { kind: 'reject'; status: 400 | 404 | 410; code: RejectCode; invalidReason: InvalidClickReason | null }
  );

const MAX_PARAM_LENGTH = 255;
const clean = (value: string | undefined): string => (value ?? '').slice(0, MAX_PARAM_LENGTH);

/** First reason (in priority order) the campaign should not serve this click, if any. */
export const campaignBlockReason = (
  campaign: CampaignSnapshot,
  link: LinkSnapshot,
  facts: Pick<ClickFacts, 'now' | 'country' | 'deviceType' | 'os' | 'browser' | 'language' | 'capReached' | 'frequencyCapReached'>
): InvalidClickReason | null => {
  if (campaign.status !== 'active') return 'campaign_inactive';
  if (campaign.startsAt && facts.now < Date.parse(campaign.startsAt)) return 'campaign_not_started';
  if (campaign.endsAt && facts.now >= Date.parse(campaign.endsAt)) return 'campaign_ended';
  if (campaign.budgetExhausted) return 'budget_reached';
  if (!link.publisherApproved) return 'publisher_not_approved';
  const country = facts.country.toUpperCase();
  if (campaign.allowedCountries.length > 0 && !campaign.allowedCountries.includes(country)) return 'geo_not_allowed';
  if (campaign.blockedCountries.includes(country)) return 'geo_not_allowed';
  if (campaign.allowedDevices.length > 0 && !campaign.allowedDevices.includes(facts.deviceType)) return 'device_not_allowed';
  const mismatch = targetingMismatch(campaign, facts);
  if (mismatch) return mismatch;
  if (facts.capReached) return 'click_cap_reached';
  if (facts.frequencyCapReached) return 'frequency_cap_reached';
  return null;
};

/** Fallback URLs are validated when the campaign is saved; this re-checks shape and HTTPS only. */
const isSafeFallback = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return validateDestinationUrl(url, { allowedHosts: [parsed.hostname], requireHttps: true }).ok;
  } catch {
    return false;
  }
};

const policyOf = (campaign: CampaignSnapshot) => ({ allowedHosts: campaign.allowedHosts, requireHttps: campaign.requireHttps });

export const decideClick = (campaign: CampaignSnapshot, link: LinkSnapshot, facts: ClickFacts): ClickDecision => {
  const { paramMap } = campaign;
  const q = facts.query;
  // Link presets win over URL parameters so a publisher's saved link cannot be re-attributed by editing the URL.
  const subs = {
    sub1: clean(link.presets.sub1 ?? q[paramMap.sub1]),
    sub2: clean(link.presets.sub2 ?? q[paramMap.sub2]),
    sub3: clean(link.presets.sub3 ?? q[paramMap.sub3]),
    sub4: clean(link.presets.sub4 ?? q[paramMap.sub4]),
    sub5: clean(link.presets.sub5 ?? q[paramMap.sub5]),
    source: clean(link.presets.source ?? q[paramMap.source]),
    // Mobile app identifiers come only from the click URL (never from link presets).
    gaid: clean(q[paramMap.gaid ?? 'gaid']),
    idfa: clean(q[paramMap.idfa ?? 'idfa']),
    appName: clean(q[paramMap.appName ?? 'app_name']),
  };
  const externalClickId = clean(q[paramMap.externalClickId] ?? q.gclid ?? q.msclkid ?? q.fbclid);

  const blockReason = campaignBlockReason(campaign, link, facts);
  const trafficReason: InvalidClickReason | null =
    facts.botReason ?? (facts.isDuplicate ? 'duplicate_click' : null) ?? (facts.isDatacenter ? 'datacenter_ip' : null);

  // force_transparent=true (the market convention, also named in Google's click tracker guidelines)
  // makes any campaign follow the transparency parameter, still limited to the campaign's allowed hosts.
  const forcedTransparent = q.force_transparent === 'true' && Boolean(q[campaign.destinationParam]);
  if (campaign.redirectMode === 'transparent' || forcedTransparent) {
    return decideTransparent(campaign, facts, { subs, externalClickId, blockReason, trafficReason });
  }

  if (blockReason) {
    if (campaign.fallbackUrl && isSafeFallback(campaign.fallbackUrl)) {
      return { kind: 'redirect', location: campaign.fallbackUrl, landingPageId: '', usedFallback: true, invalidReason: blockReason, subs, externalClickId };
    }
    return { kind: 'reject', status: 410, code: 'campaign_unavailable', invalidReason: blockReason, subs, externalClickId };
  }

  const requestedPage = q[paramMap.landingPage];
  const landingPageId =
    (requestedPage && campaign.landingPages[requestedPage] ? requestedPage : null) ??
    (link.landingPageId && campaign.landingPages[link.landingPageId] ? link.landingPageId : null) ??
    campaign.defaultLandingPageId;
  const template = campaign.landingPages[landingPageId];
  if (!template) return { kind: 'reject', status: 410, code: 'campaign_unavailable', invalidReason: 'campaign_inactive', subs, externalClickId };

  const macroValues: MacroValues = {
    click_id: facts.clickId,
    // Serial numbers (like Trackier IDs); older snapshots without them fall back to public IDs.
    campaign_id: campaign.number ? String(campaign.number) : campaign.publicId,
    publisher_id: link.publisherNumber ? String(link.publisherNumber) : link.publisherPublicId,
    advertiser_id: campaign.advertiserNumber ? String(campaign.advertiserNumber) : campaign.advertiserPublicId,
    subid1: subs.sub1,
    subid2: subs.sub2,
    subid3: subs.sub3,
    subid4: subs.sub4,
    subid5: subs.sub5,
    source: subs.source,
    gaid: subs.gaid,
    idfa: subs.idfa,
    app_name: subs.appName,
    country: facts.country,
    device: facts.deviceType,
    timestamp: Math.floor(facts.now / 1000),
    external_click_id: externalClickId,
  };

  let destination: string;
  const deepLink = q[paramMap.deepLink];
  if (campaign.allowDeepLinks && deepLink && validateDestinationUrl(deepLink, policyOf(campaign)).ok) {
    // Deep links are literal URLs supplied in the request; they are never treated as macro templates.
    destination = deepLink;
  } else {
    try {
      destination = renderTemplate(template, macroValues, { context: 'destination', encoding: 'query' });
    } catch {
      return { kind: 'reject', status: 410, code: 'destination_invalid', invalidReason: 'destination_rejected', subs, externalClickId };
    }
  }

  const finalUrl = validateDestinationUrl(destination, policyOf(campaign));
  if (!finalUrl.ok) return { kind: 'reject', status: 410, code: 'destination_invalid', invalidReason: 'destination_rejected', subs, externalClickId };
  for (const [key, value] of Object.entries(link.extraParams)) finalUrl.url.searchParams.set(key, value);

  return {
    kind: 'redirect',
    location: finalUrl.url.toString(),
    landingPageId,
    usedFallback: false,
    invalidReason: trafficReason,
    subs,
    externalClickId,
  };
};

const decideTransparent = (
  campaign: CampaignSnapshot,
  facts: ClickFacts,
  ctx: {
    subs: ClickSubs;
    externalClickId: string;
    blockReason: InvalidClickReason | null;
    trafficReason: InvalidClickReason | null;
  }
): ClickDecision => {
  const declared = facts.query[campaign.destinationParam];
  if (!declared) return { kind: 'reject', status: 400, code: 'destination_missing', invalidReason: 'destination_rejected', subs: ctx.subs, externalClickId: ctx.externalClickId };
  const validated = validateDestinationUrl(declared, policyOf(campaign));
  if (!validated.ok) return { kind: 'reject', status: 400, code: 'destination_invalid', invalidReason: 'destination_rejected', subs: ctx.subs, externalClickId: ctx.externalClickId };

  // The declared destination is honoured even when the campaign would not pay for the click:
  // the user still reaches the URL they were shown; the click is simply recorded as invalid.
  let location = declared;
  if (campaign.transparentClickIdParam) {
    validated.url.searchParams.set(campaign.transparentClickIdParam, facts.clickId);
    location = validated.url.toString();
  }
  return {
    kind: 'redirect',
    location,
    landingPageId: '',
    usedFallback: false,
    transparent: true,
    invalidReason: ctx.blockReason ?? ctx.trafficReason,
    subs: ctx.subs,
    externalClickId: ctx.externalClickId,
  };
};
