import type { DeviceType } from './bot-detection';
import type { IpStorageMode } from './ip-privacy';

/**
 * Config snapshots the API publishes to Redis and the tracker reads on every click. They are
 * the only data the redirect path touches, so they hold exactly what a redirect decision needs
 * and nothing secret (no credentials, no financial rates).
 */

export const SNAPSHOT_VERSION = 1;

export const REFERRER_POLICIES = [
  'no-referrer',
  'no-referrer-when-downgrade',
  'origin',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
] as const;
export type ReferrerPolicy = (typeof REFERRER_POLICIES)[number];

/**
 * standard:    destination comes from the campaign/link landing page (optionally a validated deep link)
 * transparent: destination is the visible `destinationParam` value on the tracking URL (e.g. the
 *              Google Ads {lpurl}); the tracker redirects to exactly that URL after validation, never
 *              to a different backend destination.
 */
export type RedirectMode = 'standard' | 'transparent';

/**
 * redirect_302: HTTP 302 with a Location header (server-side redirect).
 * html_200:     HTTP 200 HTML page that shows the destination and navigates the browser to it.
 *               Never used for transparent (Google Ads) campaigns: Google Ads requires tracking
 *               redirects to be server-side (Google Ads Help, "About tracking in Google Ads"), and
 *               this page is browser-side navigation. NTrack uses 302 for those campaigns; Google's
 *               documentation does not name a specific 3xx status code.
 */
export const REDIRECT_RESPONSES = ['redirect_302', 'html_200'] as const;
export type RedirectResponse = (typeof REDIRECT_RESPONSES)[number];

/**
 * The four Trackier-style options shown in the console. "Hide referrer" is not stored separately:
 * it is the existing Referrer-Policy set to no-referrer.
 */
export const REDIRECT_TYPES = {
  '302': { response: 'redirect_302', hideReferrer: false },
  '302_hide_referrer': { response: 'redirect_302', hideReferrer: true },
  '200': { response: 'html_200', hideReferrer: false },
  '200_hide_referrer': { response: 'html_200', hideReferrer: true },
} as const satisfies Record<string, { response: RedirectResponse; hideReferrer: boolean }>;
export type RedirectType = keyof typeof REDIRECT_TYPES;

export const redirectTypeOf = (response: RedirectResponse, referrerPolicy: string): RedirectType =>
  `${response === 'html_200' ? '200' : '302'}${referrerPolicy === 'no-referrer' ? '_hide_referrer' : ''}` as RedirectType;

/** Campaign Referrer-Policy if it is a known value, otherwise the organization default. */
export const effectiveReferrerPolicy = (campaignPolicy: string | null | undefined, organizationPolicy: string | null | undefined): ReferrerPolicy => {
  const known = (value: string | null | undefined): value is ReferrerPolicy => (REFERRER_POLICIES as readonly string[]).includes(value ?? '');
  if (known(campaignPolicy)) return campaignPolicy;
  return known(organizationPolicy) ? organizationPolicy : 'strict-origin-when-cross-origin';
};

/** Effective response for a campaign. Transparent campaigns are always 302, whatever is configured. */
export const effectiveRedirectResponse = (
  redirectMode: RedirectMode,
  campaignResponse: RedirectResponse | null | undefined,
  organizationDefault: RedirectResponse | null | undefined
): RedirectResponse => (redirectMode === 'transparent' ? 'redirect_302' : (campaignResponse ?? organizationDefault ?? 'redirect_302'));

export interface TrackingParamMap {
  sub1: string;
  sub2: string;
  sub3: string;
  sub4: string;
  sub5: string;
  source: string;
  externalClickId: string;
  landingPage: string;
  deepLink: string;
  /** Mobile app parameters (Android advertising ID, iOS IDFA, app name). */
  gaid: string;
  idfa: string;
  appName: string;
}

export const DEFAULT_PARAM_MAP: TrackingParamMap = {
  sub1: 'sub1',
  sub2: 'sub2',
  sub3: 'sub3',
  sub4: 'sub4',
  sub5: 'sub5',
  source: 'source',
  externalClickId: 'ext_click_id',
  landingPage: 'lp',
  deepLink: 'dl',
  gaid: 'gaid',
  idfa: 'idfa',
  appName: 'app_name',
};

export interface DomainSnapshot {
  v: number;
  domainId: string;
  organizationId: string;
  hostname: string;
  active: boolean;
}

export interface CampaignSnapshot {
  v: number;
  campaignId: string;
  publicId: string;
  organizationId: string;
  advertiserId: string;
  advertiserPublicId: string;
  status: 'active' | 'paused' | 'pending' | 'archived' | 'draft';
  startsAt: string | null;
  endsAt: string | null;
  dailyClickCap: number | null;
  allowedCountries: string[];
  blockedCountries: string[];
  allowedDevices: DeviceType[];
  /** Canonical values from TARGET_OPERATING_SYSTEMS / TARGET_BROWSERS; empty = no restriction. */
  allowedOperatingSystems: string[];
  allowedBrowsers: string[];
  /** Primary language subtags (`en`, `hi`) matched against Accept-Language. */
  allowedLanguages: string[];
  /** Max clicks per visitor per campaign per local day; null = unlimited. */
  frequencyCap: number | null;
  /** True when pending + approved revenue has reached the monthly or total budget (refreshed by workers). */
  budgetExhausted: boolean;
  fallbackUrl: string | null;
  attributionWindowHours: number;
  timezone: string;
  /** Landing pages keyed by public ID. URL templates may contain destination macros. */
  landingPages: Record<string, string>;
  defaultLandingPageId: string;
  allowedHosts: string[];
  requireHttps: boolean;
  allowDeepLinks: boolean;
  redirectMode: RedirectMode;
  /** Effective response (already forced to redirect_302 for transparent campaigns by config sync). */
  redirectResponse: RedirectResponse;
  destinationParam: string;
  /**
   * Transparent mode only: when set, the click ID is appended to the declared destination under
   * this query parameter. Empty means the declared destination is followed byte for byte.
   */
  transparentClickIdParam: string;
  uniqueClickWindowHours: number;
  duplicateClickWindowSeconds: number;
  /** >0 sets a first-party click cookie on the tracking domain for pixel conversions. */
  clickCookieDays: number;
  /** Domain IDs this campaign may be served from. Empty means any active domain of the organization. */
  domainIds: string[];
  referrerPolicy: ReferrerPolicy;
  collectReferrer: boolean;
  ipStorage: IpStorageMode;
  paramMap: TrackingParamMap;
}

export interface LinkSnapshot {
  v: number;
  linkId: string;
  slug: string;
  organizationId: string;
  campaignId: string;
  publisherId: string;
  publisherPublicId: string;
  active: boolean;
  publisherApproved: boolean;
  /** Overrides the campaign default landing page when set. */
  landingPageId: string | null;
  /** Domain the link was generated for. The tracker rejects the link on any other domain. */
  domainId: string;
  presets: Partial<Record<'sub1' | 'sub2' | 'sub3' | 'sub4' | 'sub5' | 'source', string>>;
  /** Extra static query parameters appended to the destination (UTM and custom). */
  extraParams: Record<string, string>;
}

/** What the tracker needs to accept an advertiser's server-to-server postback. */
export interface AdvertiserSnapshot {
  v: number;
  advertiserId: string;
  organizationId: string;
  postbackTokenHash: string | null;
  active: boolean;
}

export const REDIS_KEYS = {
  advertiser: (advertiserId: string) => `ntrack:cfg:advertiser:${advertiserId}`,
  conversionStream: 'ntrack:stream:conversions',
  domain: (hostname: string) => `ntrack:cfg:domain:${hostname.toLowerCase()}`,
  campaign: (campaignId: string) => `ntrack:cfg:campaign:${campaignId}`,
  link: (slug: string) => `ntrack:cfg:link:${slug}`,
  /** Market-style links (/click?campaign_id=&pub_id=) resolve to the publisher's first active link on that domain. */
  linkPair: (domainId: string, campaignPublicId: string, publisherPublicId: string) => `ntrack:cfg:pair:${domainId}:${campaignPublicId}:${publisherPublicId}`,
  /** Click context kept for the attribution window so conversions resolve without a DB query. */
  click: (clickId: string) => `ntrack:click:${clickId}`,
  uniqueClick: (linkId: string, fingerprint: string) => `ntrack:uniq:${linkId}:${fingerprint}`,
  duplicateBurst: (linkId: string, fingerprint: string) => `ntrack:dup:${linkId}:${fingerprint}`,
  dailyClicks: (campaignId: string, day: string) => `ntrack:cap:clicks:${campaignId}:${day}`,
  visitorFrequency: (campaignId: string, fingerprint: string, day: string) => `ntrack:freq:${campaignId}:${fingerprint}:${day}`,
  clickStream: 'ntrack:stream:clicks',
  configSyncedAt: 'ntrack:cfg:synced_at',
} as const;
