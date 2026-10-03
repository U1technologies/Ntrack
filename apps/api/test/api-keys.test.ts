import { describe, expect, it } from 'vitest';
import { ipAllowed } from '../src/middleware/api-key';
import { normalisePath } from '../src/services/api-request-log';

describe('ipAllowed', () => {
  it('allows everything when the allowlist is empty', () => {
    expect(ipAllowed([], '203.0.113.9')).toBe(true);
  });
  it('matches single IPs, CIDR ranges, IPv6 and IPv4-mapped addresses', () => {
    const list = ['203.0.113.9', '198.51.100.0/24', '2001:db8::/32'];
    expect(ipAllowed(list, '203.0.113.9')).toBe(true);
    expect(ipAllowed(list, '198.51.100.200')).toBe(true);
    expect(ipAllowed(list, '::ffff:198.51.100.7')).toBe(true);
    expect(ipAllowed(list, '2001:db8:1::5')).toBe(true);
    expect(ipAllowed(list, '203.0.113.10')).toBe(false);
    expect(ipAllowed(list, '')).toBe(false);
  });
});

describe('normalisePath', () => {
  it('drops query strings and replaces IDs so logs group by endpoint', () => {
    expect(normalisePath('/v1/campaigns/0b9c1f2e-1111-4a2b-8c3d-123456789abc/payouts?x=1')).toBe('/v1/campaigns/:id/payouts');
  });
});
