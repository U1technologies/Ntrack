import { describe, expect, it } from 'vitest';
import { REDIRECT_TYPES, effectiveRedirectResponse, effectiveReferrerPolicy, redirectTypeOf } from '../src';

describe('effectiveRedirectResponse', () => {
  it('uses the campaign override, then the organization default, then 302', () => {
    expect(effectiveRedirectResponse('standard', 'html_200', 'redirect_302')).toBe('html_200');
    expect(effectiveRedirectResponse('standard', null, 'html_200')).toBe('html_200');
    expect(effectiveRedirectResponse('standard', undefined, undefined)).toBe('redirect_302');
  });

  it('always returns 302 for transparent (Google Ads) campaigns', () => {
    expect(effectiveRedirectResponse('transparent', 'html_200', 'html_200')).toBe('redirect_302');
    expect(effectiveRedirectResponse('transparent', null, 'html_200')).toBe('redirect_302');
  });
});

describe('redirect types', () => {
  it('maps every response and referrer policy combination to one of the four options', () => {
    expect(redirectTypeOf('redirect_302', 'strict-origin-when-cross-origin')).toBe('302');
    expect(redirectTypeOf('redirect_302', 'no-referrer')).toBe('302_hide_referrer');
    expect(redirectTypeOf('html_200', 'origin')).toBe('200');
    expect(redirectTypeOf('html_200', 'no-referrer')).toBe('200_hide_referrer');
  });

  it('round-trips through the preset table', () => {
    for (const [type, preset] of Object.entries(REDIRECT_TYPES)) {
      expect(redirectTypeOf(preset.response, preset.hideReferrer ? 'no-referrer' : 'origin')).toBe(type);
    }
  });
});

describe('effectiveReferrerPolicy', () => {
  it('uses the campaign policy, then the organization default, then strict-origin-when-cross-origin', () => {
    expect(effectiveReferrerPolicy('origin', 'no-referrer')).toBe('origin');
    expect(effectiveReferrerPolicy(null, 'no-referrer')).toBe('no-referrer');
    expect(effectiveReferrerPolicy('not-a-policy', undefined)).toBe('strict-origin-when-cross-origin');
  });
});
