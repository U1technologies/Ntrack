import { describe, expect, it } from 'vitest';
import { clickIdTimestamp, generateClickId, generatePublicId, isClickId } from '../src/ids';
import { storeIp, truncateIp } from '../src/ip-privacy';

describe('click IDs', () => {
  it('are 26-char ULIDs that encode their creation time', () => {
    const now = Date.UTC(2026, 9, 3, 12, 0, 0);
    const id = generateClickId(now);
    expect(isClickId(id)).toBe(true);
    expect(clickIdTimestamp(id)).toBe(now);
  });

  it('sort by creation time', () => {
    expect(generateClickId(1000) < generateClickId(2000)).toBe(true);
  });

  it('public IDs carry a type prefix', () => {
    expect(generatePublicId('cmp')).toMatch(/^cmp_[0-9A-Za-z]{10}$/);
  });
});

describe('IP privacy', () => {
  it('truncates IPv4 to /24 and IPv6 to /48', () => {
    expect(truncateIp('203.0.113.77')).toBe('203.0.113.0');
    expect(truncateIp('2001:db8:abcd:12::1')).toBe('2001:0db8:abcd::');
  });

  it('stores nothing when IP storage is disabled', () => {
    expect(storeIp('203.0.113.77', 'none', 'k')).toBe('');
  });

  it('hashes deterministically without revealing the address', () => {
    const hashed = storeIp('203.0.113.77', 'hashed', 'k');
    expect(hashed).toHaveLength(32);
    expect(hashed).toBe(storeIp('203.0.113.77', 'hashed', 'k'));
    expect(hashed).not.toContain('203');
  });
});
