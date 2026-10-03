import { describe, expect, it } from 'vitest';
import { validateAllowedHost, validateFallbackUrl, validateLandingPageTemplate } from '../src/services/destination-validation';

describe('validateLandingPageTemplate', () => {
  it('accepts macros in the path and query', () => {
    expect(validateLandingPageTemplate('https://brand.com/{subid1}/offer?c={click_id}', true)).toBeNull();
  });

  it('rejects macros in the hostname so clicks cannot choose the destination domain', () => {
    expect(validateLandingPageTemplate('https://{subid1}.brand.com/offer', true)).toContain('hostname');
    expect(validateLandingPageTemplate('https://{subid1}/offer', true)).toContain('hostname');
  });

  it('rejects unknown macros and non-https URLs when HTTPS is required', () => {
    expect(validateLandingPageTemplate('https://brand.com/?x={foo}', true)).toContain('Unknown macro');
    expect(validateLandingPageTemplate('http://brand.com/', true)).toContain('HTTPS');
    expect(validateLandingPageTemplate('javascript:alert(1)', true)).not.toBeNull();
  });
});

describe('allowed hosts and fallbacks', () => {
  it('accepts hostnames and wildcard subdomains only', () => {
    expect(validateAllowedHost('brand.com')).toBe(true);
    expect(validateAllowedHost('*.brand.com')).toBe(true);
    expect(validateAllowedHost('https://brand.com')).toBe(false);
    expect(validateAllowedHost('*')).toBe(false);
  });

  it('requires an https fallback URL', () => {
    expect(validateFallbackUrl('https://brand.com/closed')).toBeNull();
    expect(validateFallbackUrl('http://brand.com/closed')).not.toBeNull();
  });
});
