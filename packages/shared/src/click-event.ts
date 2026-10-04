import type { DeviceType, InvalidClickReason } from './bot-detection';

/**
 * Event the tracker appends to the click stream. Workers enrich it (UA parsing) and batch it
 * into ClickHouse. Raw IPs are never part of the event; `ip` is already truncated or hashed
 * according to the organization's privacy setting.
 */
export interface ClickEvent {
  clickId: string;
  ts: number;
  organizationId: string;
  campaignId: string;
  publisherId: string;
  advertiserId: string;
  linkId: string;
  domainId: string;
  landingPageId: string;
  sub1: string;
  sub2: string;
  sub3: string;
  sub4: string;
  sub5: string;
  source: string;
  /** Mobile app identifiers passed in on the click (empty for web traffic). */
  gaid: string;
  idfa: string;
  appName: string;
  externalClickId: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmTerm: string;
  utmContent: string;
  country: string;
  region: string;
  city: string;
  deviceType: DeviceType;
  userAgent: string;
  ip: string;
  /** Organization-scoped HMAC of IP + user agent; links a visitor's clicks for attribution. */
  visitorId: string;
  referrer: string;
  referrerDomain: string;
  destinationUrl: string;
  isUnique: boolean;
  isValid: boolean;
  invalidReason: InvalidClickReason | '';
  redirectMode: string;
  /** What the tracker actually sent: redirect_302, html_200, or error (404/410/400 page). */
  responseType: 'redirect_302' | 'html_200' | 'error';
  httpStatus: number;
  referrerPolicy: string;
  /** The visitor was sent to the campaign fallback URL instead of the offer. */
  usedFallback: boolean;
  latencyMs: number;
}

/** Subset kept in Redis for the attribution window; conversions are matched against it. */
export interface ClickContext {
  clickId: string;
  ts: number;
  organizationId: string;
  campaignId: string;
  publisherId: string;
  advertiserId: string;
  linkId: string;
  domainId: string;
  sub1: string;
  sub2: string;
  sub3: string;
  sub4: string;
  sub5: string;
  source: string;
  gaid: string;
  idfa: string;
  appName: string;
  country: string;
  deviceType: DeviceType;
  externalClickId: string;
  isValid: boolean;
  invalidReason: string;
  visitorId: string;
  referrerDomain: string;
}

/** Conversion as received by the tracker (postback/pixel) or the API, before processing. */
export interface ConversionIntake {
  source: 's2s' | 'pixel' | 'javascript' | 'api' | 'manual';
  clickId: string;
  event: string;
  transactionId: string;
  saleAmount: string | null;
  currency: string;
  customParams: Record<string, string>;
  receivedAt: number;
  /** Set for API/manual intake: the user who created it. */
  actorUserId?: string;
}
