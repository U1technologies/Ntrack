# Roadmap and status

Status as of 03 Oct 2026. Dates for later phases are not committed; they need team confirmation.

## Phase 1: foundation, tracking engine, campaign management — built

| Area | Status |
|---|---|
| Authentication (sessions, CSRF, lockout, TOTP MFA, org-wide MFA requirement) | Built |
| Multi-tenant organizations, super admin, organization switcher | Built |
| 10 account types as system roles, custom roles, granular permissions, data scopes | Built |
| Advertisers, publishers (encrypted tax/payment), traffic sources | Built |
| Campaigns: targeting, caps, budgets, schedule, landing pages, payout tiers + history, approval workflow, applications, marketplace, duplicate, bulk actions, delete with confirmation | Built |
| Tracking domains: DNS ownership + routing verification, health checks, SSL and registration expiry, per-domain traffic | Built |
| Click tracker: ULID click IDs, sub IDs, UTMs, external click IDs, unique/duplicate/bot classification, caps, geo/device rules, privacy controls | Built |
| Transparent redirect engine + Google compatibility tester with downloadable report | Built |
| Link generator: single, bulk (CSV), templates, preview/validation, QR, CSV export | Built |
| Click log, dashboard, click report builder with CSV export, timezone support | Built |
| Audit log | Built |
| Tests (Phase 1 + 2): 101 unit, 21 integration (tenant isolation, scopes, CSRF, escalation, conversions) | Built |

Known Phase 1 gaps: email delivery (invites, password reset), PostgreSQL RLS as a second isolation layer, load test results.

## Phase 2: conversions, postbacks, attribution — built

| Area | Status |
|---|---|
| Conversion intake: S2S postback (`/pb`, advertiser token), pixel (`/px`, optional first-party click cookie), JavaScript tag, manual/API entry | Built |
| Queue-based processing (Redis stream → workers), retries, dead-letter and rejected streams | Built |
| Deduplication (transaction ID or click+event, unique index), attribution window, daily conversion caps, invalid-click review | Built |
| Payout/revenue from tiers (publisher > source > country > device > event), exact RevShare maths | Built |
| Status workflow (pending → approved/rejected → reversed), bulk approve, adjustments with reasons, immutable event history | Built |
| Attribution models (last, first, last non-direct, position-based, time-decay), credit history, versioned recalculation | Built |
| Postbacks/webhooks: GET/POST JSON, macro templates, bearer token, HMAC signatures, event IDs, retries with backoff, delivery log, replay, test sends | Built |
| Conversion metrics in dashboard and performance reports (revenue, payout, profit, margin, EPC, RPC, CR, ROI, AOV) with role-based visibility | Built |
| Advertiser tracking setup (token rotation, S2S URL, pixel, JS) | Built |

Phase 2 gaps: mobile measurement partner (MMP) callback presets (works today through the S2S endpoint with `event=install`).

## Tracker completion (section 2) — built

| Area | Status |
|---|---|
| Frequency cap per visitor, campaign and local day | Built |
| OS, browser and language targeting enforced on the click path (canonical lists) | Built |
| Monthly and total budget stop (`budget_reached`), refreshed every minute | Built |
| Data-centre IP flag from official AWS / GCP / Oracle ranges | Built (flag only) |

## Redirect types — built

302, 302 with Hide Referrer, 200 OK (HTML page) and 200 with Hide Referrer; organization default plus campaign override; Google Ads (transparent) campaigns locked to 302 at API, config sync and tracker; response details in click logs and reports; redirect tester for all four types. Tests: 172 unit, 30 integration.

## Phase 3: money and verticals — built

| Area | Status |
|---|---|
| Finance: double-entry ledger synced from conversions, balances, invoices (draft → issued → paid / void), credit notes, payment terms, incoming payments, publisher payouts with four-eyes approval, manual exchange rates, ledger reconciliation job | Built |
| Fraud: configurable rules (fast conversion, click burst, invalid ratio, CR spike, repeated transaction), intake checks, 5-minute scans, review queue with explicit enforcement actions, publisher appeals | Built |
| Search monetization: partners, feeds, CSV import with column mapping, manual entry, traffic costs, reconciliation against NTrack clicks | Built |
| Travel: partners, booking import (generic and HotelZoff adapters), reconciliation with 1% tolerance, missing-from-partner list | Built. **HotelZoff column mapping is unconfirmed until HotelZoff shares their report spec** |
| Notifications: in-app inbox, bell, per-type preferences, email via SMTP (off until configured), scope-aware recipients | Built |
| Scheduled reports (daily/weekly, CSV + Excel, generated per recipient with their own access) and Excel export | Built |
| Console screens for all of the above | Built |
| Tests: 152 unit, 26 integration | Built |

Phase 3 gaps: PDF export (CSV and Excel are available), automatic FX rates (rates are entered manually), payment provider payouts (payouts are recorded, not sent), search/travel record-level listing and delete endpoints, HotelZoff spec confirmation.

## Platform essentials (priority 1) — in progress

| Area | Status |
|---|---|
| Email invitations (accept flow, resend, revoke, copyable link while email is off) and self-service password reset | Built |
| Data export and deletion requests | Planned next |
| Public API keys with permissions, usage limits and API logs | Planned |
| PostgreSQL row-level security | Planned |

## Phase 4: SaaS

- Public API keys / OAuth, usage limits, API logs
- White-label branding, own domain for the console (route constants already centralised)
- Subscription billing
- Data export and deletion endpoints (GDPR/DPDP)

## Migration from Trackier

Run in parallel on the same campaigns and compare click counts, conversion matching, duplicate handling, redirect latency, postback delivery, revenue reconciliation and uptime. Migrate only after those match.
