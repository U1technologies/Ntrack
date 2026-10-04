import { DEFAULT_PARAM_MAP, type CampaignSnapshot, type DomainSnapshot, type LinkSnapshot } from '@ntrack/shared';

export const ORG = '11111111-1111-4111-8111-111111111111';
export const DOMAIN_ID = '22222222-2222-4222-8222-222222222222';
export const CAMPAIGN_ID = '33333333-3333-4333-8333-333333333333';
export const LINK_ID = '44444444-4444-4444-8444-444444444444';
export const PUBLISHER_ID = '55555555-5555-4555-8555-555555555555';
export const ADVERTISER_ID = '66666666-6666-4666-8666-666666666666';

export const makeDomain = (overrides: Partial<DomainSnapshot> = {}): DomainSnapshot => ({
  v: 1,
  domainId: DOMAIN_ID,
  organizationId: ORG,
  hostname: 'trk.example.com',
  active: true,
  ...overrides,
});

export const makeCampaign = (overrides: Partial<CampaignSnapshot> = {}): CampaignSnapshot => ({
  v: 1,
  campaignId: CAMPAIGN_ID,
  publicId: 'cmp_TEST000001',
  number: 12,
  organizationId: ORG,
  advertiserId: ADVERTISER_ID,
  advertiserPublicId: 'adv_TEST000001',
  status: 'active',
  startsAt: null,
  endsAt: null,
  dailyClickCap: null,
  allowedCountries: [],
  blockedCountries: [],
  allowedDevices: [],
  allowedOperatingSystems: [],
  allowedBrowsers: [],
  allowedLanguages: [],
  frequencyCap: null,
  budgetExhausted: false,
  fallbackUrl: null,
  attributionWindowHours: 720,
  timezone: 'UTC',
  landingPages: {
    lp_main: 'https://brand.com/offer?aff={click_id}&s1={subid1}',
    lp_alt: 'https://brand.com/alt?aff={click_id}',
  },
  defaultLandingPageId: 'lp_main',
  allowedHosts: ['brand.com', '*.brand.com'],
  requireHttps: true,
  allowDeepLinks: false,
  redirectMode: 'standard',
  redirectResponse: 'redirect_302',
  destinationParam: 'url',
  transparentClickIdParam: '',
  uniqueClickWindowHours: 24,
  duplicateClickWindowSeconds: 10,
  clickCookieDays: 0,
  domainIds: [],
  referrerPolicy: 'strict-origin-when-cross-origin',
  collectReferrer: true,
  ipStorage: 'truncated',
  paramMap: DEFAULT_PARAM_MAP,
  ...overrides,
});

export const makeLink = (overrides: Partial<LinkSnapshot> = {}): LinkSnapshot => ({
  v: 1,
  linkId: LINK_ID,
  slug: 'AbCdEf1234',
  organizationId: ORG,
  campaignId: CAMPAIGN_ID,
  publisherId: PUBLISHER_ID,
  publisherPublicId: 'pub_TEST000001',
  publisherNumber: 3,
  active: true,
  publisherApproved: true,
  landingPageId: null,
  domainId: DOMAIN_ID,
  presets: {},
  extraParams: {},
  ...overrides,
});
