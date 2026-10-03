import { randomBytes } from 'node:crypto';
import type { ReferrerPolicy } from '@ntrack/shared';

/**
 * HTTP 200 navigation page for the "200" redirect types. Design rules:
 *  - Transparent: the destination host and full URL are visible on the page, with a plain link.
 *  - Identical for every visitor and user agent (no cloaking): the page depends only on the
 *    already validated destination and the configured referrer policy.
 *  - Three navigation paths so it works everywhere: meta refresh, location.replace, and the link.
 *  - Every dynamic value is escaped for its context (HTML text, attribute, JS string), and a
 *    nonce-based CSP allows only this page's own inline script and style.
 */

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** JSON string literal that is safe inside a <script> element. */
const scriptString = (value: string): string =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export interface HtmlRedirect {
  html: string;
  /** Content-Security-Policy header value for this response. */
  csp: string;
}

export const buildHtmlRedirect = (destination: string, referrerPolicy: ReferrerPolicy): HtmlRedirect => {
  // Normalising through URL guarantees an absolute http(s) URL with reserved characters encoded.
  const url = new URL(destination);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('HTML redirect destination must be http(s)');
  const href = url.toString();
  const host = url.hostname;
  const nonce = randomBytes(16).toString('base64');
  const hideReferrer = referrerPolicy === 'no-referrer';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="${escapeHtml(referrerPolicy)}">
<meta http-equiv="refresh" content="0;url=${escapeHtml(href)}">
<title>Redirecting to ${escapeHtml(host)}</title>
<style nonce="${nonce}">body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:#f6f7fb;color:#1f2937;display:flex;min-height:100vh;align-items:center;justify-content:center}main{max-width:560px;margin:24px;padding:28px;background:#fff;border:1px solid #e5e7eb;border-radius:12px}p{margin:0 0 8px}.host{font-size:20px;font-weight:700}.url{font-size:12px;color:#6b7280;word-break:break-all;margin-bottom:20px}a{display:inline-block;padding:10px 16px;border-radius:8px;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600}</style>
</head>
<body>
<main>
<p>You are being taken to</p>
<p class="host">${escapeHtml(host)}</p>
<p class="url">${escapeHtml(href)}</p>
<a id="go" href="${escapeHtml(href)}"${hideReferrer ? ' rel="noreferrer"' : ''}>Continue to ${escapeHtml(host)}</a>
</main>
<script nonce="${nonce}">window.location.replace(${scriptString(href)});</script>
</body>
</html>`;

  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  return { html, csp };
};
