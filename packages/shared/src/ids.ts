import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const randomString = (alphabet: string, length: number): string => {
  // Rejection sampling keeps the distribution uniform for alphabets that do not divide 256.
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit) out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
};

/**
 * Click IDs are ULIDs: 26 chars, Crockford base32, lexicographically sortable by creation time,
 * 80 bits of randomness. Sortable IDs keep ClickHouse and Redis lookups cache friendly and let
 * us read the click time from the ID without a database round trip.
 */
export const generateClickId = (now: number = Date.now()): string => {
  let time = now;
  let timePart = '';
  for (let i = 0; i < 10; i += 1) {
    timePart = CROCKFORD[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  return timePart + randomString(CROCKFORD, 16);
};

const CLICK_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const isClickId = (value: unknown): value is string => typeof value === 'string' && CLICK_ID_PATTERN.test(value);

export const clickIdTimestamp = (clickId: string): number =>
  clickId
    .slice(0, 10)
    .split('')
    .reduce((acc, char) => acc * 32 + CROCKFORD.indexOf(char), 0);

export type PublicIdPrefix = 'org' | 'adv' | 'pub' | 'cmp' | 'lnk' | 'lp' | 'dom' | 'cnv' | 'pb' | 'inv' | 'key' | 'pay' | 'po' | 'sp' | 'tp';

/** Public IDs are what appear in URLs, exports and macros; database UUIDs never leave the API. */
export const generatePublicId = (prefix: PublicIdPrefix, length = 10): string => `${prefix}_${randomString(BASE62, length)}`;

/** Short, unguessable path segment for tracking links (`/click/{slug}`). */
export const generateLinkSlug = (length = 10): string => randomString(BASE62, length);

/** URL-safe secret for sessions, API keys, verification tokens. */
export const generateSecretToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
