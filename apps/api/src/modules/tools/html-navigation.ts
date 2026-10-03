/**
 * Reads client-side navigation out of an HTML page (meta refresh, location.replace / href
 * assignment, the first link) so the redirect tester can follow "200" redirect types and check
 * that the page is transparent. Pattern based on purpose: the tester inspects pages, it never
 * executes them.
 */

export interface HtmlNavigation {
  metaRefreshUrl: string | null;
  metaRefreshDelay: number | null;
  metaReferrer: string | null;
  scriptUrl: string | null;
  linkUrl: string | null;
  linkRel: string | null;
  robots: string | null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'", '#47': '/', '#x2F': '/' };

export const decodeEntities = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (ENTITIES[lower] !== undefined) return ENTITIES[lower]!;
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return match;
  });

/** Attributes of every occurrence of `<tag ...>` in the document. */
const tagAttributes = (html: string, tag: string): Array<Record<string, string>> => {
  const out: Array<Record<string, string>> = [];
  const tagPattern = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
  for (const [, raw = ''] of html.matchAll(tagPattern)) {
    const attrs: Record<string, string> = {};
    for (const [, name = '', dq, sq, bare] of raw.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      attrs[name.toLowerCase()] = decodeEntities(dq ?? sq ?? bare ?? '');
    }
    out.push(attrs);
  }
  return out;
};

const absolute = (value: string | null | undefined, base: string): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value.trim(), base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
};

/** `0;url=https://…` (quotes optional) → delay and URL. */
const parseRefresh = (content: string, base: string): { delay: number | null; url: string | null } => {
  const match = /^\s*(\d+(?:\.\d+)?)?\s*[;,]?\s*(?:url\s*=\s*)?(['"]?)(.*?)\2\s*$/i.exec(content);
  if (!match) return { delay: null, url: null };
  return { delay: match[1] !== undefined ? Number(match[1]) : null, url: absolute(match[3], base) };
};

/** First `location.replace("…")` / `location.assign("…")` / `location.href = "…"` with a string literal. */
const scriptTarget = (html: string, base: string): string | null => {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1] ?? '').join('\n');
  const match =
    /location\s*\.\s*(?:replace|assign)\s*\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)/.exec(scripts) ??
    /location(?:\s*\.\s*href)?\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/.exec(scripts);
  if (!match?.[1]) return null;
  const literal = match[1];
  try {
    const value = literal.startsWith('"') ? (JSON.parse(literal) as string) : (JSON.parse(`"${literal.slice(1, -1).replace(/"/g, '\\"')}"`) as string);
    return absolute(value, base);
  } catch {
    return null;
  }
};

export const inspectHtmlNavigation = (html: string, baseUrl: string): HtmlNavigation => {
  const metas = tagAttributes(html, 'meta');
  const refresh = metas.find((m) => m['http-equiv']?.toLowerCase() === 'refresh');
  const parsedRefresh = refresh?.content ? parseRefresh(refresh.content, baseUrl) : { delay: null, url: null };
  const link = tagAttributes(html, 'a').find((a) => a.href);
  return {
    metaRefreshUrl: parsedRefresh.url,
    metaRefreshDelay: parsedRefresh.delay,
    metaReferrer: metas.find((m) => m.name?.toLowerCase() === 'referrer')?.content?.toLowerCase() ?? null,
    scriptUrl: scriptTarget(html, baseUrl),
    linkUrl: absolute(link?.href, baseUrl),
    linkRel: link?.rel?.toLowerCase() ?? null,
    robots: metas.find((m) => m.name?.toLowerCase() === 'robots')?.content ?? null,
  };
};

/** Where the page sends the browser: meta refresh first (works without JavaScript), then script. */
export const htmlNavigationTarget = (nav: HtmlNavigation): string | null => nav.metaRefreshUrl ?? nav.scriptUrl;
