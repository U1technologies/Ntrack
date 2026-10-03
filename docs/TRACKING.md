# Tracking, macros and transparent redirects

## Tracking links

```
https://<tracking-domain>/click/<slug>?sub1=…&sub2=…&source=…&lp=<landing-page-id>&dl=<deep-link>
```

- `<slug>` is a random 10-character token. Internal IDs never appear in URLs.
- Nextagmedia's own tracking domain is `trk.nextagmedia.com` (DNS on Hostinger, pointing directly at the tracker, not through the website).
- Public paths: `/click/<slug>`, `/postback`, `/pixel`, `/ntrack.js`. The short forms `/c/<slug>`, `/pb`, `/px` and `/js/ntrack.js` keep working for links and snippets created earlier.
- A link only works on the domain it was generated for (domain and tenant isolation).
- Parameter names are configurable per organization (Settings → Tracking & privacy). Defaults: `sub1`–`sub5`, `source`, `ext_click_id`, `lp`, `dl`.
- Sub IDs saved on the link win over URL parameters, so a shared link cannot be re-attributed by editing it.
- `gclid`, `msclkid` and `fbclid` are captured as the external click ID when `ext_click_id` is absent.

## Redirect modes

### Standard

The visitor goes to the campaign landing page (the link's page, a valid `?lp=` choice, or the default). If the campaign allows deep links, `?dl=` is followed only when its host is on the campaign allowlist; otherwise it is ignored. When a campaign cannot serve the click (paused, ended, capped, geo/device not allowed, publisher not approved), the visitor goes to the campaign's declared HTTPS fallback URL, or sees an "offer unavailable" page. The click is recorded as invalid with the reason.

### Transparent (Google Ads compatible)

Tracking template for the ad platform:

```
https://trk.nextagmedia.com/click/<slug>?url={lpurl}
```

The tracker redirects to **exactly** the URL in the destination parameter (`url` by default), after checking it is HTTPS and on the campaign's allowed hosts. It never substitutes another destination:

- Missing or invalid declared destination → `400`, no redirect.
- Campaign paused, capped or otherwise unpayable → the visitor still reaches the declared URL; the click is recorded as invalid.
- Optional: append the click ID under a named parameter (e.g. `ntclid`). Leave it empty to follow the declared URL byte for byte.

### Redirect types (response)

Configured per organization (default) and per campaign (override). "Hide referrer" is not a separate setting: it is the Referrer-Policy set to `no-referrer`.

| Type | Response | Referrer | Google Ads |
|---|---|---|---|
| 302 | HTTP 302 + `Location` | Configured Referrer-Policy | Yes |
| 302 with Hide Referrer | HTTP 302 + `Location` | `Referrer-Policy: no-referrer` | Yes |
| 200 OK | HTTP 200 HTML page: shows the destination host and URL, meta refresh + `location.replace` + visible link | Header and `<meta name="referrer">` | **No** |
| 200 with Hide Referrer | Same page | `no-referrer` in header, meta and `rel="noreferrer"` on the link | **No** |

Rules:
- **Transparent (Google Ads) campaigns always use HTTP 302.** The API rejects `html_200` for them (on create and on any update that would combine the two), config sync forces 302 into the snapshot, and the tracker checks again. An organization default of 200 applies to standard campaigns only. Basis: Google Ads Help, "About tracking in Google Ads" (support.google.com/google-ads/answer/6076199): "The redirects also need to be server-side." and "The tracking template URL and all redirect URLs need to be HTTPS to work." Google's documentation does not name a specific status code; 302 is NTrack's choice of server-side redirect. "About parallel tracking" (answer/7544674) gives no further redirect rules.
- The HTML page goes through exactly the same destination validation as a 302, is identical for every visitor and user agent, is `no-store` and `noindex`, and runs under a nonce-based CSP. The fallback URL uses the same response type.
- Every click logs `response_type` (`redirect_302`, `html_200`, `error`), `http_status`, `referrer_policy` and `used_fallback`. They appear in the click log (with a response filter) and as report dimensions. Responses also carry `X-NTrack-Response` and `X-NTrack-Click-Id` headers for debugging.

Use **Tracking Domains → Redirect tester** to check behaviour hop by hop. It works for all four types: it compares the configured type with what the tracker actually sent, follows HTML navigation as well as `Location`, checks the Referrer-Policy (header, page meta, link rel), checks the HTML page is transparent, confirms a browser and Google's AdsBot get the same answer (HEAD probes, not counted as clicks), applies the Google Ads rule and verifies the final destination. It reports observed behaviour only. It is not Google certification; certification comes from Google's own review.

## What NTrack will not do

No cloaking, no different destinations for reviewers and visitors, no hidden intermediate hops, no falsified referrers, no silent domain rotation to evade enforcement. Referrer settings control what the next page receives (`Referrer-Policy`) and what NTrack stores; they never misrepresent the traffic source.

## Click classification

Every click is recorded. Invalid clicks carry an explainable reason:

| Reason | Meaning |
|---|---|
| `bot_user_agent`, `empty_user_agent` | Automated or missing user agent |
| `duplicate_click` | Same visitor and link within the duplicate window (default 10 s) |
| `campaign_inactive`, `campaign_not_started`, `campaign_ended` | Campaign status or schedule |
| `publisher_not_approved` | Publisher inactive or not approved on the campaign |
| `geo_not_allowed`, `device_not_allowed` | Country or device targeting |
| `os_not_allowed`, `browser_not_allowed`, `language_not_allowed` | OS, browser or language targeting. Values are a fixed canonical list the tracker can detect; language is the primary subtag of the visitor's `Accept-Language` (a visitor with no language header fails a language rule) |
| `click_cap_reached` | Daily click cap (resets at midnight in the organization timezone) |
| `frequency_cap_reached` | The same visitor (keyed IP + user agent fingerprint) clicked this campaign more than the frequency cap today. HEAD requests do not count |
| `budget_reached` | Pending + approved revenue reached the monthly or total budget. Refreshed by the workers every minute, so enforcement can lag spend by about a minute |
| `datacenter_ip` | **Flag only, still redirected.** The IP is in a published AWS, Google Cloud or Oracle Cloud range. VPNs and corporate proxies live there too, so this never blocks |
| `destination_rejected` | Destination failed validation |

All reasons except `datacenter_ip`, bots and duplicates are *block* reasons: in standard mode the visitor goes to the fallback URL (or the unavailable page); in transparent mode the visitor still reaches the declared URL and the click is recorded as invalid.

Data-centre ranges come from `packages/shared/data/datacenter-ranges.json`, generated by `node scripts/update-datacenter-ranges.mjs` from the providers' official lists. Refresh it before each tracker release (it is copied into the image). Azure is not included because its list sits behind a rotating download URL.

Unique clicks: first click per visitor and link within the unique window (default 24 h).

## Conversions

| Method | How | Notes |
|---|---|---|
| Server-to-server (recommended) | Advertiser calls `https://<domain>/postback?click_id=…&token=…&event=sale&txn_id=…&amount=…&currency=USD` | Token per advertiser (Advertiser → Conversion tracking). POST form/JSON also accepted |
| Pixel | `<img src="https://<domain>/pixel?event=sale&txn_id=…">` on the thank-you page | Needs `click_id` in the URL or the click cookie (Settings → Tracking & privacy, off by default) |
| JavaScript | `<script src="https://<domain>/ntrack.js">` then `ntrack.convert({...})` | Stores the click ID from `?ntclid=`, `?click_id=` or `?aff_click=` on landing |
| Manual / API | Console or `POST /v1/conversions` | Same checks as postbacks |

Processing: the tracker validates and queues; workers check the click exists and is inside the attribution window, deduplicate (transaction ID, or click + event), apply the daily conversion cap, resolve payout/revenue from tiers, compute attribution credits, store the conversion with an event trail, mirror it to ClickHouse and queue postbacks. Conversions from clicks flagged invalid are kept pending for review. Campaigns can auto-approve conversions from valid clicks.

## Outbound postbacks

Events: `conversion.created`, `.approved`, `.rejected`, `.reversed`, `.adjusted`. Each delivery carries `X-NTrack-Event`, `X-NTrack-Event-Id` (stable across retries), `X-NTrack-Timestamp`, optional `Authorization: Bearer …` and `X-NTrack-Signature: sha256=<hex of HMAC(secret, timestamp + "." + body-or-url)>`. Failed deliveries retry 8 times with exponential backoff (30 s base) and can be replayed from the delivery log. Publisher-owned postbacks never receive `{revenue}`.

## Macros

Syntax `{name}`; `{{` and `}}` are literal braces. Unknown macros are rejected when a template is saved. Values are URL-encoded, so they can never add parameters. Macros are not allowed in the scheme or hostname.

| Macro | Destination | Postback (Phase 2) | Description |
|---|:-:|:-:|---|
| `{click_id}` | ✓ | ✓ | NTrack click ID (ULID) |
| `{campaign_id}` `{publisher_id}` `{advertiser_id}` | ✓ | ✓ | Public IDs |
| `{subid1}`…`{subid5}` | ✓ | ✓ | Sub IDs |
| `{source}` `{country}` `{device}` `{timestamp}` `{external_click_id}` | ✓ | ✓ | Click attributes |
| `{conversion_id}` `{transaction_id}` `{event}` `{status}` `{revenue}` `{payout}` `{currency}` | | ✓ | Conversion attributes |

## Privacy

- IP storage per organization: truncated (IPv4 /24, IPv6 /48, default), keyed hash, or none. Raw IPs only exist in memory during the request.
- Referrers are stored without query strings or fragments.
- Country/region/city come from Cloudflare headers, only when `TRUST_PROXY=true`.
- Click retention: ClickHouse TTL (400 days default, configurable per organization in settings for future enforcement jobs).
