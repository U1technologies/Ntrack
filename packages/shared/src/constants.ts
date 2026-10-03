export const CAMPAIGN_CATEGORIES = [
  'Finance',
  'Banking',
  'Insurance',
  'Travel',
  'Hotels',
  'Flights',
  'Car Rentals',
  'Ecommerce',
  'Fashion',
  'Electronics',
  'Gaming',
  'Software',
  'SaaS',
  'Education',
  'Health',
  'Utilities',
  'Mobile Apps',
  'Lead Generation',
  'Search Monetization',
  'Other',
] as const;

export const PAYOUT_MODELS = ['CPA', 'CPL', 'CPS', 'CPI', 'CPC', 'CPM', 'REVSHARE', 'HYBRID'] as const;
export type PayoutModel = (typeof PAYOUT_MODELS)[number];

export const CAMPAIGN_STATUSES = ['draft', 'pending', 'active', 'paused', 'archived'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const ATTRIBUTION_MODELS = ['last_click', 'first_click', 'last_non_direct', 'position_based', 'time_decay'] as const;
export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];

export const CONVERSION_EVENTS = [
  'lead',
  'sale',
  'signup',
  'registration',
  'purchase',
  'install',
  'subscription',
  'qualified_lead',
  'deposit',
  'custom',
] as const;

export const TRAFFIC_TYPES = [
  'search',
  'social',
  'display',
  'native',
  'email',
  'content',
  'coupon',
  'cashback',
  'push',
  'pop',
  'incentivized',
  'brand_bidding',
  'influencer',
  'other',
] as const;

export const DEVICE_TYPES = ['desktop', 'mobile', 'tablet', 'other'] as const;

export const PAYMENT_TERMS = ['NET7', 'NET15', 'NET30', 'NET45', 'NET60', 'CUSTOM'] as const;

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD', 'SGD', 'AED'] as const;

export const POSTBACK_QUEUE = 'ntrack-postbacks';
export const POSTBACK_EVENTS = ['conversion.created', 'conversion.approved', 'conversion.rejected', 'conversion.reversed', 'conversion.adjusted'] as const;
export type PostbackEvent = (typeof POSTBACK_EVENTS)[number];
