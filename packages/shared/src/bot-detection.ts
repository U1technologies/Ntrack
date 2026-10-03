/**
 * Lightweight, explainable bot classification for the click hot path. It only flags; whether a
 * flagged click is counted, rejected or reviewed is decided by fraud rules later. Every flag
 * carries a reason so publishers can see why a click was marked invalid.
 */
export type InvalidClickReason =
  | 'bot_user_agent'
  | 'empty_user_agent'
  | 'duplicate_click'
  | 'campaign_inactive'
  | 'campaign_not_started'
  | 'campaign_ended'
  | 'click_cap_reached'
  | 'publisher_not_approved'
  | 'geo_not_allowed'
  | 'device_not_allowed'
  | 'os_not_allowed'
  | 'browser_not_allowed'
  | 'language_not_allowed'
  | 'frequency_cap_reached'
  | 'budget_reached'
  | 'datacenter_ip'
  | 'destination_rejected';

const BOT_PATTERNS: RegExp[] = [
  /bot\b/i,
  /crawl/i,
  /spider/i,
  /slurp/i,
  /headless/i,
  /phantomjs/i,
  /puppeteer/i,
  /playwright/i,
  /selenium/i,
  /python-requests|python-urllib|aiohttp/i,
  /curl\//i,
  /wget\//i,
  /go-http-client/i,
  /java\/\d/i,
  /okhttp/i,
  /axios\//i,
  /node-fetch/i,
  /libwww-perl/i,
  /scrapy/i,
  /httpclient/i,
  /facebookexternalhit/i,
  /preview/i,
  /monitor/i,
  /lighthouse/i,
  /ntrack-compat/i,
];

export const classifyUserAgent = (userAgent: string | undefined): InvalidClickReason | null => {
  if (!userAgent || userAgent.trim().length < 8) return 'empty_user_agent';
  return BOT_PATTERNS.some((pattern) => pattern.test(userAgent)) ? 'bot_user_agent' : null;
};

export type DeviceType = 'desktop' | 'mobile' | 'tablet' | 'other';

/** Coarse device class for targeting on the hot path; workers do full UA parsing later. */
export const detectDeviceType = (userAgent: string | undefined): DeviceType => {
  if (!userAgent) return 'other';
  if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/i.test(userAgent)) return 'tablet';
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile|windows phone/i.test(userAgent)) return 'mobile';
  if (/windows|macintosh|linux|cros|x11/i.test(userAgent)) return 'desktop';
  return 'other';
};
