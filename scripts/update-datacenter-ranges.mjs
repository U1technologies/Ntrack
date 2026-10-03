#!/usr/bin/env node
/**
 * Downloads the official published IP ranges of AWS, Google Cloud and Oracle Cloud into
 * packages/shared/data/datacenter-ranges.json. The tracker loads that file at startup to flag
 * (never block) clicks from cloud servers as `datacenter_ip`.
 *
 * Run before each tracker deploy, or weekly from CI:  node scripts/update-datacenter-ranges.mjs
 * Azure publishes its list behind a rotating download URL, so it is not included automatically.
 */
import { writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

const OUTPUT = fileURLToPath(new URL('../packages/shared/data/datacenter-ranges.json', import.meta.url));

const SOURCES = [
  {
    name: 'aws',
    url: 'https://ip-ranges.amazonaws.com/ip-ranges.json',
    extract: (data) => [...(data.prefixes ?? []).map((p) => p.ip_prefix), ...(data.ipv6_prefixes ?? []).map((p) => p.ipv6_prefix)],
  },
  {
    name: 'gcp',
    url: 'https://www.gstatic.com/ipranges/cloud.json',
    extract: (data) => (data.prefixes ?? []).map((p) => p.ipv4Prefix ?? p.ipv6Prefix),
  },
  {
    name: 'oracle',
    url: 'https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json',
    extract: (data) => (data.regions ?? []).flatMap((region) => (region.cidrs ?? []).map((c) => c.cidr)),
  },
];

const isCidr = (value) => {
  if (typeof value !== 'string') return false;
  const [address, prefix] = value.split('/');
  const family = isIP(address ?? '');
  const bits = Number(prefix);
  return family !== 0 && Number.isInteger(bits) && bits >= 0 && bits <= (family === 4 ? 32 : 128);
};

const fetchSource = async (source) => {
  const response = await fetch(source.url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${source.name}: HTTP ${response.status}`);
  const cidrs = source.extract(await response.json()).filter(isCidr);
  if (cidrs.length === 0) throw new Error(`${source.name}: no ranges found (format changed?)`);
  return cidrs;
};

const results = await Promise.allSettled(SOURCES.map(fetchSource));
const failures = results.map((r, i) => (r.status === 'rejected' ? `${SOURCES[i].name}: ${r.reason?.message ?? r.reason}` : null)).filter(Boolean);
if (failures.length > 0) {
  // Never write a partial file: a missing provider would silently stop flagging its traffic.
  console.error(`Failed to download ranges, existing file left unchanged:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}

const cidrs = [...new Set(results.flatMap((r) => r.value))].sort();
const counts = Object.fromEntries(SOURCES.map((s, i) => [s.name, results[i].value.length]));
await writeFile(OUTPUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), sources: SOURCES.map((s) => s.url), cidrs }, null, 0)}\n`);
console.log(`Wrote ${cidrs.length} ranges to ${OUTPUT}`, counts);
