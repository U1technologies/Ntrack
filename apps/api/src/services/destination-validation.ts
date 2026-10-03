import {
  isValidHostname,
  normalizeHostname,
  parseTemplate,
  renderSegments,
  validateDestinationUrl,
  URL_REJECTION_MESSAGES,
} from '@ntrack/shared';

const SAMPLE_VALUES = {
  click_id: '01J9Z3QK4T8W2M6N7P5R0S1V2X',
  campaign_id: 'cmp_sample',
  publisher_id: 'pub_sample',
  advertiser_id: 'adv_sample',
  subid1: 's1',
  subid2: 's2',
  subid3: 's3',
  subid4: 's4',
  subid5: 's5',
  source: 'search',
  country: 'US',
  device: 'desktop',
  timestamp: '1759449600',
  external_click_id: 'gclid',
};

/**
 * Validates a landing page URL template. Macros are allowed only in the path, query or fragment:
 * a macro in the scheme or host would let click parameters choose the destination domain.
 * Returns an error message or null.
 */
export const validateLandingPageTemplate = (template: string, requireHttps: boolean): string | null => {
  const parsed = parseTemplate(template, 'destination');
  if (parsed.errors.length) return parsed.errors.join(' ');
  const authorityEnd = template.indexOf('/', template.indexOf('//') + 2);
  const authority = authorityEnd === -1 ? template : template.slice(0, authorityEnd);
  if (authority.includes('{')) return 'Macros are not allowed in the scheme or hostname.';
  const rendered = renderSegments(parsed.segments, SAMPLE_VALUES, 'query');
  let host: string;
  try {
    host = new URL(rendered).hostname;
  } catch {
    return URL_REJECTION_MESSAGES.malformed;
  }
  const result = validateDestinationUrl(rendered, { allowedHosts: [host], requireHttps });
  return result.ok ? null : URL_REJECTION_MESSAGES[result.reason];
};

export const validateAllowedHost = (entry: string): boolean => {
  const host = normalizeHostname(entry);
  return host.startsWith('*.') ? isValidHostname(host.slice(2)) : isValidHostname(host);
};

export const validateFallbackUrl = (url: string): string | null => {
  try {
    const result = validateDestinationUrl(url, { allowedHosts: [new URL(url).hostname], requireHttps: true });
    return result.ok ? null : URL_REJECTION_MESSAGES[result.reason];
  } catch {
    return URL_REJECTION_MESSAGES.malformed;
  }
};
