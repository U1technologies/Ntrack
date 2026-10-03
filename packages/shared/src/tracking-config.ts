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
  /** Click context kept for the attribution window so conversions resolve without a DB query. */
  click: (clickId: string) => `ntrack:click:${clickId}`,
  uniqueClick: (linkId: string, fingerprint: string) => `ntrack:uniq:${linkId}:${fingerprint}`,
  duplicateBurst: (linkId: string, fingerprint: string) => `ntrack:dup:${linkId}:${fingerprint}`,
  dailyClicks: (campaignId: string, day: string) => `ntrack:cap:clicks:${campaignId}:${day}`,
  visitorFrequency: (campaignId: string, fingerprint: string, day: string) => `ntrack:freq:${campaignId}:${fingerprint}:${day}`,
  clickStream: 'ntrack:stream:clicks',
  configSyncedAt: 'ntrack:cfg:synced_at',
} as const;
