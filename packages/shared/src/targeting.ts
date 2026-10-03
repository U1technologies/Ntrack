/**
 * Coarse OS / browser / language classification for targeting on the click hot path. The lists
 * are deliberately small and canonical: campaigns can only target values the tracker can
 * actually detect, so a saved rule is always enforceable. Workers do full UA parsing for reports.
 */

export const TARGET_OPERATING_SYSTEMS = ['ios', 'android', 'windows', 'macos', 'linux', 'chromeos', 'other'] as const;
export type TargetOperatingSystem = (typeof TARGET_OPERATING_SYSTEMS)[number];

export const TARGET_BROWSERS = ['chrome', 'safari', 'firefox', 'edge', 'opera', 'samsung', 'other'] as const;
export type TargetBrowser = (typeof TARGET_BROWSERS)[number];

/** ISO 639 primary language subtag (`en`, `hi`, `fil`). Region subtags are not targetable. */
export const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}$/;

export const detectOs = (userAgent: string | undefined): TargetOperatingSystem => {
  if (!userAgent) return 'other';
  // Order matters: iPadOS and Android UAs also contain "Mac OS X" / "Linux".
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'ios';
  if (/android/i.test(userAgent)) return 'android';
  if (/cros/i.test(userAgent)) return 'chromeos';
  if (/windows/i.test(userAgent)) return 'windows';
  if (/macintosh|mac os x/i.test(userAgent)) return 'macos';
  if (/linux|x11/i.test(userAgent)) return 'linux';
  return 'other';
};

export const detectBrowser = (userAgent: string | undefined): TargetBrowser => {
  if (!userAgent) return 'other';
  // Chromium derivatives announce Chrome too, so they are matched first.
  if (/samsungbrowser/i.test(userAgent)) return 'samsung';
  if (/edg(e|a|ios)?\//i.test(userAgent)) return 'edge';
  if (/opr\/|opera|opt\//i.test(userAgent)) return 'opera';
  if (/firefox|fxios/i.test(userAgent)) return 'firefox';
  if (/chrome|crios|chromium/i.test(userAgent)) return 'chrome';
  if (/safari/i.test(userAgent)) return 'safari';
  return 'other';
};

/** Highest-weighted primary language from an Accept-Language header, or '' when absent/invalid. */
export const primaryLanguage = (acceptLanguage: string | undefined): string => {
  if (!acceptLanguage) return '';
  let best = '';
  let bestQ = 0;
  for (const part of acceptLanguage.slice(0, 256).split(',')) {
    const [tag = '', ...params] = part.trim().split(';');
    const code = tag.split('-')[0]?.toLowerCase() ?? '';
    if (!LANGUAGE_CODE_PATTERN.test(code)) continue;
    const qParam = params.find((p) => p.trim().startsWith('q='));
    const q = qParam ? Number(qParam.trim().slice(2)) : 1;
    if (Number.isFinite(q) && q > bestQ) {
      best = code;
      bestQ = q;
    }
  }
  return best;
};

export interface TargetingRules {
  allowedOperatingSystems: string[];
  allowedBrowsers: string[];
  allowedLanguages: string[];
}

export interface VisitorTraits {
  os: TargetOperatingSystem;
  browser: TargetBrowser;
  language: string;
}

/** Empty lists mean "no restriction". A visitor with no language header fails a language rule. */
export const targetingMismatch = (
  rules: TargetingRules,
  visitor: VisitorTraits
): 'os_not_allowed' | 'browser_not_allowed' | 'language_not_allowed' | null => {
  if (rules.allowedOperatingSystems.length > 0 && !rules.allowedOperatingSystems.includes(visitor.os)) return 'os_not_allowed';
  if (rules.allowedBrowsers.length > 0 && !rules.allowedBrowsers.includes(visitor.browser)) return 'browser_not_allowed';
  if (rules.allowedLanguages.length > 0 && !rules.allowedLanguages.includes(visitor.language)) return 'language_not_allowed';
  return null;
};
