import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatacenterMatcher, EMPTY_DATACENTER_MATCHER, type DatacenterRangeFile } from '@ntrack/shared';

const DEFAULT_LOCATIONS = ['packages/shared/data/datacenter-ranges.json', '../../packages/shared/data/datacenter-ranges.json'];

/**
 * Loads cloud provider ranges once at startup. A missing or unreadable file disables the
 * `datacenter_ip` flag rather than failing the tracker: the flag is advisory, redirects are not.
 */
export const loadDatacenterMatcher = (
  configuredPath: string,
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void }
): DatacenterMatcher => {
  const candidates = configuredPath ? [configuredPath] : DEFAULT_LOCATIONS.map((path) => resolve(process.cwd(), path));
  const file = candidates.find((path) => existsSync(path));
  if (!file) {
    log.warn({ candidates }, 'datacenter ranges file not found; datacenter_ip flag disabled');
    return EMPTY_DATACENTER_MATCHER;
  }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as DatacenterRangeFile;
    const matcher = new DatacenterMatcher(Array.isArray(data.cidrs) ? data.cidrs : []);
    log.info({ file, ranges: matcher.size, generatedAt: data.generatedAt }, 'datacenter ranges loaded');
    return matcher;
  } catch (error) {
    log.warn({ file, err: error }, 'datacenter ranges file unreadable; datacenter_ip flag disabled');
    return EMPTY_DATACENTER_MATCHER;
  }
};
