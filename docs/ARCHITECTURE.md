# Architecture

## Overview

```
Browser ──► nextagmedia.com/ntrack/*  (Next.js on Vercel: console UI)
              │  /ntrack/api/* rewrite (same origin, first-party cookies)
              ▼
           NTrack API (Express) ──► PostgreSQL (config, partners, campaigns, audit, ledger later)
              │  publishes snapshots      ▲
              ▼                            │ periodic full resync
            Redis ◄──────────────── Workers (BullMQ + stream consumer) ──► ClickHouse (clicks)
              ▲                            ▲
              │ snapshot reads             │ XREADGROUP batches
Visitor ──► Tracker (Fastify) ── XADD click event ──┘
  click.brand.com/c/<slug>  ──302──► declared destination
```

## Design principles

1. **The click path never queries PostgreSQL.** The tracker reads three Redis keys (domain, link, campaign snapshot), decides, responds, and only then appends the click to a Redis stream. A slow database cannot slow redirects.
2. **Config snapshots are the contract.** `packages/config-sync` builds them from PostgreSQL. The API publishes after every committed change; workers rewrite all snapshots every 5 minutes and delete orphans, which repairs drift (e.g. a Redis flush).
3. **Transparent redirects only.** Destinations are declared campaign landing pages, allowlisted deep links, or (transparent mode) the URL visible in the tracking request. See [TRACKING.md](TRACKING.md).
4. **Tenant isolation in one place.** Every tenant table has `organization_id`. Services always filter by organization and through `services/access-scope.ts` for data-level scopes (advertiser, publisher, managed). The tracker rejects a link served on a domain from another tenant.
5. **Analytics are computed from stored events.** Dashboards and reports query ClickHouse; nothing is estimated.

## Request flow: a click

1. `GET https://click.brand.com/c/AbCdEf1234?sub1=google`
2. Tracker resolves the host and slug snapshots (one `MGET`), then the campaign snapshot.
3. Visitor fingerprint (HMAC of IP + UA) marks unique / duplicate in Redis (`SET NX EX`).
4. `decideClick()` (pure, unit-tested) applies status, schedule, approval, geo, device and cap rules, picks the destination, renders macros, re-validates the final URL.
5. `302` with `Referrer-Policy`, `Cache-Control: no-store`, `X-Robots-Tag: noindex`.
6. After the response: `XADD ntrack:stream:clicks` + click context (`ntrack:click:<id>`, TTL = attribution window) + cap counter.
7. Workers read the stream in batches of up to 1,000, parse user agents, insert into ClickHouse with an `insert_deduplication_token`, then `XACK`/`XDEL`. Entries left pending by a crashed worker are reclaimed after 60 s.

## Data stores

| Store | Holds | Notes |
|---|---|---|
| PostgreSQL | Organizations, users, roles, permissions, sessions, audit logs, advertisers, publishers, campaigns, landing pages, payout tiers and history, applications, domains, health checks, links, templates | Prisma schema `packages/db/prisma/schema.prisma`. Money as `Decimal(18,6)` (sub-cent CPC/CPM rates) |
| Redis | Snapshots (`ntrack:cfg:*`), click stream, click context, unique/duplicate keys, cap counters, BullMQ, rate limits | Run with AOF and `noeviction` so stream data is never evicted |
| ClickHouse | `clicks` (MergeTree, monthly partitions, 400-day TTL, bloom index on click_id) | Report queries come from whitelisted dimensions/metrics with bound parameters |

## Frontend integration

- Console: App Router tree `app/(ntrack)` with its own root layout, so the public site's `_app.js` Navbar/Footer never wrap it. Pages: `app/(ntrack)/ntrack/(console)/*`.
- Landing page: `pages/ntrack/index.js` (Pages Router, inside the site shell).
- NTrack code lives in `ntrack/` and never imports public-site code.
- `middleware.js` redirects signed-out visitors to `/ntrack/login`; the console layout re-checks the session server-side; the API checks every request.

## Decisions

| Decision | Why |
|---|---|
| Separate `ntrack-platform` repo | Isolates a tracking and money system from the marketing site's deploys and secrets; ready to sell as SaaS |
| Express MVC for the API, Fastify for the tracker | Team familiarity and MoonDive standard for the API; lowest overhead for the hot path |
| Session cookie (opaque token, hashed in DB) over JWT | Instant revocation (logout, password change, MFA changes) |
| Redis Streams for clicks, BullMQ for jobs | One `XADD` on the hot path; batched ClickHouse inserts; BullMQ schedulers run once across replicas |
| Decimal money | CPC/CPM rates need more than cent precision; values serialize as strings |
