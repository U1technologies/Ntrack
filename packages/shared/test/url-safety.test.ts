import { describe, expect, it } from 'vitest';
import { hostMatchesAllowlist, isPrivateAddress, validateDestinationUrl, validateOutboundUrl } from '../src/url-safety';

const policy = { allowedHosts: ['brand.com', '*.brand.com'], requireHttps: true };

describe('validateDestinationUrl', () => {
  it('accepts an https URL on an allowlisted host', () => {
    expect(validateDestinationUrl('https://brand.com/offer?x=1', policy).ok).toBe(true);
    expect(validateDestinationUrl('https://shop.brand.com/p', policy).ok).toBe(true);
  });

  it('rejects hosts outside the allowlist, including look-alike suffixes', () => {
    expect(validateDestinationUrl('https://evil.com', policy)).toEqual({ ok: false, reason: 'host_not_allowlisted' });
    expect(validateDestinationUrl('https://evilbrand.com', policy)).toEqual({ ok: false, reason: 'host_not_allowlisted' });
    expect(validateDestinationUrl('https://brand.com.evil.com', policy)).toEqual({ ok: false, reason: 'host_not_allowlisted' });
  });

  it('rejects non-http protocols used for script injection', () => {
    expect(validateDestinationUrl('javascript:alert(1)', policy)).toEqual({ ok: false, reason: 'unsupported_protocol' });
    expect(validateDestinationUrl('data:text/html,hi', policy)).toEqual({ ok: false, reason: 'unsupported_protocol' });
  });

  it('rejects plain http when HTTPS is required', () => {
    expect(validateDestinationUrl('http://brand.com', policy)).toEqual({ ok: false, reason: 'https_required' });
  });

  it('rejects credentials and IP literals', () => {
    expect(validateDestinationUrl('https://user:pass@brand.com', policy)).toEqual({ ok: false, reason: 'credentials_in_url' });
    expect(validateDestinationUrl('https://93.184.216.34/', { ...policy, allowedHosts: ['93.184.216.34'] })).toEqual({
      ok: false,
      reason: 'ip_literal_not_allowed',
    });
  });

  it('rejects malformed and oversized URLs', () => {
    expect(validateDestinationUrl('not a url', policy)).toEqual({ ok: false, reason: 'malformed' });
    expect(validateDestinationUrl(`https://brand.com/${'a'.repeat(3000)}`, policy)).toEqual({ ok: false, reason: 'too_long' });
  });
});

describe('hostMatchesAllowlist', () => {
  it('does not let a wildcard match the apex domain', () => {
    expect(hostMatchesAllowlist('brand.com', ['*.brand.com'])).toBe(false);
    expect(hostMatchesAllowlist('a.b.brand.com', ['*.brand.com'])).toBe(true);
  });
});

describe('isPrivateAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1'])(
    'treats %s as private',
    (ip) => expect(isPrivateAddress(ip)).toBe(true)
  );
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('treats %s as public', (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe('validateOutboundUrl', () => {
  it('blocks metadata endpoints and localhost for SSRF protection', () => {
    expect(validateOutboundUrl('https://169.254.169.254/latest/meta-data').ok).toBe(false);
    expect(validateOutboundUrl('https://localhost:4000/admin').ok).toBe(false);
    expect(validateOutboundUrl('https://partner.example.com/postback').ok).toBe(true);
  });
});
