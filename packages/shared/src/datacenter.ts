import { isIP } from 'node:net';

/**
 * Matches IPs against published cloud provider ranges (AWS, Google Cloud, Oracle Cloud). A hit
 * only flags the click as `datacenter_ip`; it never blocks the redirect, because VPNs, corporate
 * proxies and privacy relays also sit in these ranges. Ranges are merged and searched with a
 * binary search so a lookup stays O(log n) on the click path.
 */

export interface DatacenterRangeFile {
  generatedAt: string;
  sources: string[];
  cidrs: string[];
}

type Range = [bigint, bigint];

const ipv4ToBigInt = (ip: string): bigint | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    const octet = Number(part);
    if (!/^\d{1,3}$/.test(part) || octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
};

const ipv6ToBigInt = (ip: string): bigint | null => {
  let address = ip.split('%')[0] ?? '';
  // IPv4-mapped / embedded tail (::ffff:1.2.3.4).
  const v4Tail = address.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Tail?.[1]) {
    const v4 = ipv4ToBigInt(v4Tail[1]);
    if (v4 === null) return null;
    address = `${address.slice(0, -v4Tail[1].length)}${((v4 >> 16n) & 0xffffn).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
};

const parseCidr = (cidr: string): { family: 4 | 6; range: Range } | null => {
  const [address = '', prefixText] = cidr.trim().split('/');
  const family = isIP(address);
  if (family !== 4 && family !== 6) return null;
  const bits = family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? bits : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return null;
  const base = family === 4 ? ipv4ToBigInt(address) : ipv6ToBigInt(address);
  if (base === null) return null;
  const hostBits = BigInt(bits - prefix);
  const start = (base >> hostBits) << hostBits;
  return { family, range: [start, start + (1n << hostBits) - 1n] };
};

const mergeRanges = (ranges: Range[]): Range[] => {
  const sorted = [...ranges].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1] + 1n) {
      if (range[1] > last[1]) last[1] = range[1];
    } else {
      merged.push([range[0], range[1]]);
    }
  }
  return merged;
};

const contains = (ranges: Range[], value: bigint): boolean => {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid] as Range;
    if (value < range[0]) high = mid - 1;
    else if (value > range[1]) low = mid + 1;
    else return true;
  }
  return false;
};

export class DatacenterMatcher {
  private readonly v4: Range[];
  private readonly v6: Range[];

  constructor(cidrs: readonly string[]) {
    const v4: Range[] = [];
    const v6: Range[] = [];
    for (const cidr of cidrs) {
      const parsed = parseCidr(cidr);
      if (!parsed) continue;
      (parsed.family === 4 ? v4 : v6).push(parsed.range);
    }
    this.v4 = mergeRanges(v4);
    this.v6 = mergeRanges(v6);
  }

  get size(): number {
    return this.v4.length + this.v6.length;
  }

  matches(ip: string): boolean {
    const family = isIP(ip);
    if (family === 4) {
      const value = ipv4ToBigInt(ip);
      return value !== null && contains(this.v4, value);
    }
    if (family === 6) {
      const value = ipv6ToBigInt(ip);
      if (value === null) return false;
      // IPv4-mapped IPv6 (::ffff:a.b.c.d) is checked against the IPv4 table.
      if (value >> 32n === 0xffffn) return contains(this.v4, value & 0xffffffffn);
      return contains(this.v6, value);
    }
    return false;
  }
}

export const EMPTY_DATACENTER_MATCHER = new DatacenterMatcher([]);
