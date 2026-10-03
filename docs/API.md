# API reference (v1)

Base URL: `https://nextagmedia.com/ntrack/api` (proxied to the API's `/v1`). Locally: `http://localhost:4000/v1`.

## Conventions

- **Envelope:** `{ "success": true, "message": "OK", "data": … }`. Errors: `{ "success": false, "message": "…", "code": "bad_request" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "csrf" | "mfa_required" | …, "data": { "fields": [{ "path": "email", "message": "…" }] } }`.
- **Auth:** session cookie set by `POST /auth/login`. Every non-GET request needs `X-CSRF-Token` equal to the `ntrack_csrf` cookie (get one from `GET /auth/csrf`).
- **Pagination:** `?page=1&pageSize=25` → `data: { items: [...], pagination: { page, pageSize, total, totalPages } }`.
- **Money:** decimal strings (`"6.50"`). **IDs:** UUIDs in paths; public IDs (`cmp_…`, `pub_…`) in URLs shared outside the console.
- **Status codes:** 200, 201 created, 400 validation, 401 signed out, 403 permission/CSRF, 404 not found or outside your scope, 409 conflict, 423 locked, 429 rate limited.

## Auth

| Method | Path | Notes |
|---|---|---|
| GET | `/auth/csrf` | Issues the CSRF cookie |
| POST | `/auth/login` | `{ email, password }` → `{ mfaRequired }` |
| POST | `/auth/mfa/verify` | `{ code }` completes MFA login |
| POST | `/auth/logout` | |
| GET | `/auth/me` | User, active organization, role, scope, permissions |
| POST | `/auth/switch-organization` | `{ organizationId }` |
| POST | `/auth/mfa/setup` · `/auth/mfa/enable` · `/auth/mfa/disable` | TOTP setup returns `{ secret, qrCodeDataUrl }` |
| POST | `/auth/password` | `{ currentPassword, newPassword }` |

```bash
curl -c jar -b jar https://nextagmedia.com/ntrack/api/auth/csrf
curl -c jar -b jar -H "X-CSRF-Token: <token>" -H "Content-Type: application/json" \
  -d '{"email":"you@nextagmedia.com","password":"…"}' https://nextagmedia.com/ntrack/api/auth/login
```

## Organization and access

| Method | Path | Permission |
|---|---|---|
| GET / PATCH | `/organizations/current`, `/organizations/current/settings` | settings.view / settings.manage |
| GET / POST / PATCH | `/organizations`, `/organizations/:id` | platform super admin |
| GET | `/roles/permissions` | signed in (catalogue) |
| GET / POST / PATCH / DELETE | `/roles`, `/roles/:id` | roles.view / roles.manage |
| GET / POST / PATCH / DELETE | `/users`, `/users/:id` | users.view / users.manage |
| PUT | `/users/:id/assignments` | users.manage — `{ advertiserIds, publisherIds }` for managed roles |
| POST | `/users/:id/reset-password` | users.manage |
| GET | `/audit-logs?entityType=&entityId=&action=&actor=&from=&to=` | audit.view |

## Partners

| Method | Path | Permission |
|---|---|---|
| GET / POST | `/advertisers` | advertisers.view / .manage |
| GET / PATCH / DELETE | `/advertisers/:id` | advertisers.view / .manage |
| GET / POST | `/publishers` | publishers.view / .manage |
| GET / PATCH / DELETE | `/publishers/:id` | publishers.view / .manage |
| POST | `/publishers/:id/decision` | publishers.approve — `{ status: "active" \| "rejected" \| "suspended", note }` |
| GET / POST / PATCH / DELETE | `/traffic-sources[/:id]` | campaigns.view / .manage |

## Campaigns

| Method | Path | Permission |
|---|---|---|
| GET | `/campaigns?status=&advertiserId=&category=&search=&sort=&direction=` | campaigns.view |
| POST | `/campaigns` | campaigns.manage |
| GET / PATCH / DELETE | `/campaigns/:id` | view / manage / delete (`{ confirmName }`) |
| POST | `/campaigns/:id/status` | `{ status, note }`; activating needs campaigns.approve |
| POST | `/campaigns/:id/duplicate` | campaigns.manage |
| POST | `/campaigns/bulk` | `{ action: "status", ids, status }` or `{ action: "update", ids, data }` |
| GET / POST / PATCH / DELETE | `/campaigns/:id/landing-pages[/:pageId]` | campaigns.view / .manage |
| GET / POST / PATCH / DELETE | `/campaigns/:id/payouts[/:tierId]` | payouts.view / .manage |
| GET | `/campaigns/:id/payouts/history` | payouts.view |
| GET | `/campaigns/applications?status=&campaignId=&publisherId=` | campaigns.view |
| PATCH | `/campaigns/applications/:applicationId` | campaigns.approve |
| POST | `/campaigns/:id/publishers` | campaigns.approve — grant/block access directly |
| POST | `/campaigns/:id/apply` | publisher portal |
| GET | `/campaigns/marketplace` | campaigns.view |

Create example:

```json
POST /campaigns
{
  "name": "Spring Hotel Deals",
  "advertiserId": "6f1c…",
  "category": "Hotels",
  "status": "active",
  "payoutModel": "CPA",
  "defaultPayout": "6.00",
  "defaultRevenue": "9.00",
  "geoAllowed": ["US", "GB"],
  "dailyClickCap": 50000,
  "redirectMode": "standard",
  "allowedHosts": ["*.brand.com"],
  "landingPages": [{ "name": "Main", "url": "https://brand.com/hotels?aff={click_id}&s1={subid1}", "isDefault": true }]
}
```

## Tracking domains and links

| Method | Path | Permission |
|---|---|---|
| GET / POST | `/domains` | domains.view (or links.manage for listing) / domains.manage |
| GET / PATCH / DELETE | `/domains/:id` | domains.view / .manage |
| POST | `/domains/:id/verify` | Checks TXT ownership + CNAME/A routing |
| POST | `/domains/:id/check` | Runs a health check now |
| GET / POST | `/links` | links.view / links.manage |
| PATCH | `/links/:id` | `{ name, active, landingPageId }` |
| POST | `/links/preview` | Builds the URL and validates the destination without saving |
| POST | `/links/bulk` | Up to 500 rows |
| GET | `/links/export.csv` | links.view or reports.export |
| GET / POST / DELETE | `/links/templates[/:id]` | Saved generator presets |
| POST | `/tools/redirect-test` | `{ trackingUrl, destinationParam, expectedFinalUrl? }` → compatibility report |

## Conversions and postbacks

| Method | Path | Permission |
|---|---|---|
| GET | `/conversions?preset=&status=&campaignId=&publisherId=&source=&search=` | conversions.view (returns `summary` by status) |
| GET | `/conversions/export.csv` | reports.export |
| POST | `/conversions` | conversions.manage — `{ clickId, event, transactionId?, saleAmount?, currency? }` (same checks as postbacks) |
| GET | `/conversions/:id` | Events, attribution credits, deliveries |
| POST | `/conversions/:id/status` | conversions.approve — `{ status, note }`; transitions: pending→approved/rejected, approved→rejected/reversed, rejected→approved/pending |
| POST | `/conversions/bulk-status` | conversions.approve — `{ ids, status, note }` |
| POST | `/conversions/:id/adjust` | conversions.manage (+ payouts.manage for rates) — `{ payout?, revenue?, saleAmount?, note }` |
| POST | `/conversions/:id/recalculate-attribution` | attribution.manage — `{ model }` (adds a credit version, payouts unchanged) |
| GET / POST / PATCH / DELETE | `/postbacks[/:id]` | postbacks.view / .manage. Secrets (`authToken`, `hmacSecret`) are write-only |
| POST | `/postbacks/:id/test` | Sends sample values once |
| GET | `/postbacks/deliveries?postbackId=&status=` | Delivery log |
| POST | `/postbacks/deliveries/:id/replay` | Re-queues with the same event ID |
| GET | `/postbacks/macros` | Macro documentation |
| GET | `/advertisers/:id/tracking-setup` | S2S URL, pixel and JS snippets |
| POST | `/advertisers/:id/postback-token` | Issues/rotates the S2S token |

## Analytics

All accept `preset` (`today`, `yesterday`, `last_7_days`, `last_30_days`, `this_month`, `previous_month`, `custom` with `from`/`to` as `YYYY-MM-DD`) and `timezone`.

| Method | Path | Notes |
|---|---|---|
| GET | `/analytics/dashboard` | KPIs, trend, distributions, top lists, recent clicks, pending approvals |
| GET | `/analytics/clicks?campaignId=&publisherId=&domainId=&clickId=&country=&onlyInvalid=` | Click log, 50/page |
| POST | `/analytics/reports/clicks` | `{ dimensions[], metrics[], filters{}, sort, limit, offset }` |
| POST | `/analytics/reports/clicks/export?format=csv\|xlsx` | Same body, CSV or Excel response |
| POST | `/analytics/reports/performance` | Clicks + conversions merged by dimension; metrics also `conversions approved_conversions pending_conversions rejected_conversions revenue payout sale_amount profit margin epc rpc cr roi aov` (role-filtered) |
| POST | `/analytics/reports/performance/export?format=csv\|xlsx` | CSV or Excel |

Dimensions: `date hour campaign publisher advertiser domain link landing_page country device os browser source referrer_domain sub1…sub5 invalid_reason`. Metrics: `clicks unique_clicks valid_clicks invalid_clicks avg_latency_ms`.

## Finance

| Method | Path | Permission |
|---|---|---|
| GET | `/finance/overview` | finance.view, organization-wide roles only. Totals per currency and converted with the latest manual rates (`null` while a rate is missing) |
| GET | `/finance/balances` | finance.view. Advertiser receivables / publisher payables, scoped to the caller |
| GET | `/finance/journals?page=` | finance.view, organization-wide |
| GET / POST | `/finance/invoices` | view / finance.manage — `{ advertiserId, periodStart, periodEnd, currency, taxRate, notes }` creates a draft from approved, uninvoiced conversions |
| GET | `/finance/invoices/:id` | Lines, payments, issuer |
| POST | `/finance/invoices/:id/issue` \| `/void` \| `/credit-note` | finance.manage. Credit note body `{ amount, reason }` |
| GET / POST | `/finance/payments` | view / finance.manage — incoming advertiser payment `{ advertiserId, invoiceId?, amount, currency, method, reference, paidAt }` |
| GET / POST | `/finance/payouts` | finance.view. Publishers request their own available balance; staff need finance.manage |
| POST | `/finance/payouts/:id/approve` \| `/reject` \| `/mark-paid` | finance.approve. Approver must differ from requester |
| GET / POST | `/finance/exchange-rates` | view / finance.manage — `{ currency, rateToBase, effectiveDate }` |

## Fraud

| Method | Path | Permission |
|---|---|---|
| GET | `/fraud/rule-types` | fraud.view |
| GET / POST / PATCH / DELETE | `/fraud/rules[/:id]` | fraud.manage |
| GET | `/fraud/events?status=&severity=&type=&publisherId=` | fraud.view (publishers see their own events without internal details) |
| POST | `/fraud/events/:id/review` | fraud.manage — `{ status: confirmed\|dismissed, note, actions[] }`; actions `reject_conversion`, `block_on_campaign`, `suspend_publisher` apply only when confirming |
| POST | `/fraud/events/:id/appeal` | Affected publisher — `{ note }` |

## Search monetization

| Method | Path | Permission |
|---|---|---|
| GET / POST / PATCH | `/search/partners[/:id]` | search.view / search.manage |
| POST | `/search/partners/:id/feeds`, PATCH `/search/feeds/:feedId` | search.manage. Linked campaigns must belong to the organization |
| POST | `/search/partners/:id/import` | `{ csv, dateFormat, mapping }`. Rows for the same feed, date and country are summed; re-importing replaces |
| POST | `/search/records` | Manual entry (decimal strings) |
| GET / POST / DELETE | `/search/costs[/:id]` | Traffic costs |
| GET | `/search/report?preset=&groupBy=date\|feed\|partner&partnerId=` | Rows are split by currency; `unallocatedCosts` lists costs not tied to a feed |

## Travel

| Method | Path | Permission |
|---|---|---|
| GET | `/travel/adapters` | travel.view (`specConfirmed: false` = mapping not yet confirmed by the partner) |
| GET / POST / PATCH | `/travel/partners[/:id]` | travel.view / travel.manage |
| POST | `/travel/partners/:id/import` | `{ csv, dateFormat, productType, mapping }`. Unknown statuses or product types are skipped with a reason |
| POST | `/travel/partners/:id/reconcile` | Matches bookings to conversions (booking ref = transaction ID, 1% tolerance) |
| GET | `/travel/partners/:id/missing` | Conversions on the linked campaign missing from the partner report (first 200 + `total`) |
| GET | `/travel/bookings?partnerId=&reconciliation=&search=` | Paginated with summary |

## Notifications and scheduled reports

| Method | Path | Permission |
|---|---|---|
| GET | `/notifications?unread=true&page=` | Any member, own notifications only |
| GET | `/notifications/unread-count` | |
| POST | `/notifications/:id/read`, `/notifications/read-all` | |
| GET / PUT | `/notifications/preferences` | Only types the caller can receive; PUT `{ items: [{ type, inApp, email }] }` |
| GET / POST / PATCH / DELETE | `/scheduled-reports[/:id]` | reports.schedule, own schedules only. Recipients must be members with reports.view |
| POST | `/scheduled-reports/:id/run` | Sends now |

## Tracker (public)

| Method | Path | |
|---|---|---|
| GET/HEAD | `/c/:slug` | Click redirect (HEAD is answered but not recorded) |
| GET/POST | `/pb?click_id=&token=&event=&txn_id=&amount=&currency=` | S2S conversion postback → `202 accepted` / `401 invalid_token` / `404 unknown_or_expired_click` |
| GET | `/px?click_id=&event=&txn_id=&amount=` | Conversion pixel (always returns a 1×1 GIF) |
| GET | `/js/ntrack.js` | JavaScript conversion tag (`ntrack.convert({...})`) |
| GET | `/health`, `/ready` | Liveness / Redis readiness |
| GET | `/.well-known/ntrack` | Lets domain health checks confirm routing |
