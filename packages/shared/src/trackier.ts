/**
 * Mapping rules for importing from Trackier. Column names and macro names follow Trackier's help
 * centre and common exports; they are defaults only. Every import shows the detected columns and
 * lets the user remap them, because exports vary by account and Trackier version.
 */

export const IMPORT_ENTITIES = ['advertisers', 'publishers', 'campaigns', 'payouts', 'approvals'] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

export interface ImportField {
  key: string;
  label: string;
  required: boolean;
  /** Lower-case header names tried in order when no mapping is given. */
  headers: string[];
}

const field = (key: string, label: string, required: boolean, headers: string[]): ImportField => ({ key, label, required, headers });

export const IMPORT_FIELDS: Record<ImportEntity, ImportField[]> = {
  advertisers: [
    field('externalId', 'Trackier advertiser ID', true, ['advertiser id', 'id', 'advertiser_id']),
    field('companyName', 'Company name', true, ['company', 'company name', 'advertiser name', 'name', 'advertiser']),
    field('email', 'Email', true, ['email', 'email address', 'contact email']),
    field('contactName', 'Contact name', false, ['contact name', 'contact', 'manager']),
    field('phone', 'Phone', false, ['phone', 'phone number', 'mobile']),
    field('website', 'Website', false, ['website', 'url', 'site']),
    field('country', 'Country (2-letter)', false, ['country', 'country code']),
    field('currency', 'Currency', false, ['currency']),
    field('status', 'Status', false, ['status']),
  ],
  publishers: [
    field('externalId', 'Trackier publisher ID', true, ['publisher id', 'id', 'pub_id', 'publisher_id', 'affiliate id']),
    field('companyName', 'Company or publisher name', true, ['company', 'company name', 'publisher name', 'name', 'publisher']),
    field('email', 'Email', true, ['email', 'email address']),
    field('contactName', 'Contact name', false, ['contact name', 'contact', 'full name']),
    field('phone', 'Phone', false, ['phone', 'phone number', 'mobile']),
    field('website', 'Website', false, ['website', 'url', 'site']),
    field('country', 'Country (2-letter)', false, ['country', 'country code']),
    field('status', 'Status', false, ['status']),
  ],
  campaigns: [
    field('externalId', 'Trackier campaign ID', true, ['campaign id', 'id', 'campaign_id', 'offer id']),
    field('name', 'Campaign name', true, ['campaign name', 'name', 'title', 'campaign']),
    field('advertiserExternalId', 'Trackier advertiser ID', true, ['advertiser id', 'advertiser_id']),
    field('url', 'Tracking destination URL', true, ['url', 'tracking url', 'destination url', 'landing page url', 'campaign url']),
    field('previewUrl', 'Preview URL', false, ['preview url', 'preview']),
    field('category', 'Category', false, ['category', 'vertical']),
    field('status', 'Status', false, ['status']),
    field('visibility', 'Visibility', false, ['visibility', 'access', 'privacy']),
    field('currency', 'Currency', false, ['currency']),
    field('payoutModel', 'Payout model', false, ['payout type', 'payout model', 'type']),
    field('payout', 'Default payout', false, ['payout', 'default payout']),
    field('revenue', 'Default revenue', false, ['revenue', 'default revenue']),
    field('countries', 'Allowed countries', false, ['countries', 'geo', 'allowed countries', 'country']),
    field('dailyClickCap', 'Daily click cap', false, ['daily click cap', 'click cap']),
    field('dailyConversionCap', 'Daily conversion cap', false, ['daily conversion cap', 'conversion cap', 'daily cap']),
    field('description', 'Description', false, ['description', 'kpi', 'notes']),
  ],
  payouts: [
    field('campaignExternalId', 'Trackier campaign ID', true, ['campaign id', 'campaign_id']),
    field('payout', 'Payout', true, ['payout']),
    field('revenue', 'Revenue', false, ['revenue']),
    field('goal', 'Goal / event', false, ['goal', 'goal name', 'event']),
    field('country', 'Country (2-letter)', false, ['country', 'geo']),
    field('publisherExternalId', 'Trackier publisher ID (tier for one publisher)', false, ['publisher id', 'pub_id', 'publisher_id']),
    field('isPercentage', 'Percentage payout (yes/no)', false, ['percentage', 'is percentage', 'revshare']),
  ],
  approvals: [
    field('campaignExternalId', 'Trackier campaign ID', true, ['campaign id', 'campaign_id']),
    field('publisherExternalId', 'Trackier publisher ID', true, ['publisher id', 'pub_id', 'publisher_id']),
    field('status', 'Access status', false, ['status', 'approval status']),
  ],
};

/** Picks a mapping {fieldKey: header} from the CSV headers using the default header names. */
export const autoMapColumns = (entity: ImportEntity, headers: string[]): Record<string, string> => {
  const lower = new Map(headers.map((h) => [h.trim().toLowerCase(), h]));
  const mapping: Record<string, string> = {};
  for (const f of IMPORT_FIELDS[entity]) {
    const hit = f.headers.find((candidate) => lower.has(candidate));
    if (hit) mapping[f.key] = lower.get(hit)!;
  }
  return mapping;
};

const norm = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');

export const mapPartnerStatus = (value: string): 'active' | 'pending' | 'suspended' | 'rejected' => {
  const v = norm(value);
  if (['active', 'approved', 'enabled'].includes(v)) return 'active';
  if (['rejected', 'declined'].includes(v)) return 'rejected';
  if (['inactive', 'disabled', 'banned', 'blocked', 'suspended', 'paused'].includes(v)) return 'suspended';
  return v ? 'pending' : 'active';
};

export const mapCampaignStatus = (value: string): 'active' | 'paused' | 'pending' | 'archived' => {
  const v = norm(value);
  if (['active', 'live', 'running'].includes(v)) return 'active';
  if (['pending', 'pending approval', 'draft'].includes(v)) return 'pending';
  if (['expired', 'deleted', 'archived', 'completed', 'disabled'].includes(v)) return 'archived';
  return 'paused';
};

export const mapVisibility = (value: string): 'public' | 'approval_required' | 'private' => {
  const v = norm(value);
  if (v === 'public') return 'public';
  if (['private', 'hidden'].includes(v)) return 'private';
  return 'approval_required';
};

export const mapAccessStatus = (value: string): 'approved' | 'pending' | 'rejected' | 'blocked' => {
  const v = norm(value);
  if (['approved', 'active', 'enabled'].includes(v) || !v) return 'approved';
  if (['rejected', 'declined'].includes(v)) return 'rejected';
  if (['blocked', 'banned', 'disabled'].includes(v)) return 'blocked';
  return 'pending';
};

/** Trackier macro -> NTrack macro. Unknown macros make the row invalid so nothing breaks silently. */
export const TRACKIER_MACROS: Record<string, string> = {
  click_id: 'click_id',
  clickid: 'click_id',
  campaign_id: 'campaign_id',
  pub_id: 'publisher_id',
  publisher_id: 'publisher_id',
  aff_id: 'publisher_id',
  source: 'source',
  p1: 'subid1',
  p2: 'subid2',
  p3: 'subid3',
  p4: 'subid4',
  p5: 'subid5',
  sub1: 'subid1',
  sub2: 'subid2',
  sub3: 'subid3',
  sub4: 'subid4',
  sub5: 'subid5',
  country: 'country',
  device: 'device',
  timestamp: 'timestamp',
};

/**
 * Rewrites Trackier macros in a destination URL to NTrack macros. Note: {campaign_id} and
 * {pub_id} become NTrack's public IDs, not Trackier's numeric IDs, which is reported as a warning.
 */
export const translateTrackierUrl = (url: string): { url: string; unknown: string[]; idMacros: string[] } => {
  const unknown: string[] = [];
  const idMacros: string[] = [];
  const translated = url.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    const target = TRACKIER_MACROS[name.toLowerCase()];
    if (!target) {
      unknown.push(name);
      return match;
    }
    if (target === 'campaign_id' || target === 'publisher_id') idMacros.push(name);
    return `{${target}}`;
  });
  return { url: translated, unknown: [...new Set(unknown)], idMacros: [...new Set(idMacros)] };
};

/** Category text -> NTrack category, falling back to "Other". */
export const mapCategory = <T extends readonly string[]>(value: string, categories: T): T[number] => {
  const v = norm(value);
  return categories.find((c) => norm(c) === v) ?? categories.find((c) => norm(c) === 'other') ?? categories[0]!;
};

/** Goal name -> NTrack conversion event (keeps "custom" when nothing fits). */
export const mapGoal = <T extends readonly string[]>(value: string, events: T): T[number] | null => {
  const v = norm(value).replace(/ /g, '_');
  if (!v) return null;
  return events.find((e) => e === v) ?? (v.includes('lead') ? events.find((e) => e === 'lead') : undefined) ?? (v.includes('sale') || v.includes('purchase') ? events.find((e) => e === 'sale') : undefined) ?? events.find((e) => e === 'custom') ?? null;
};
