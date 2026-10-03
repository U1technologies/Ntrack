# NTrack Platform

Backend services for **NTrack by Nextagmedia**, an affiliate tracking and performance marketing platform. The console UI lives in the Nextagmedia website repository under `/ntrack`.

| Service | Path | What it does |
|---|---|---|
| API | `apps/api` | Express (MVC) REST API for the console: auth, RBAC, partners, campaigns, domains, links, analytics |
| Tracker | `apps/tracker` | Fastify click redirect service. Reads config from Redis only, never touches PostgreSQL on a click |
| Workers | `apps/workers` | Click stream → ClickHouse, conversion processing, postback delivery, email, tracker config sync, budget guard, fraud scans, ledger reconciliation, domain health checks, session cleanup |

Shared packages: `packages/shared` (permissions, URL safety, macro parser, IDs), `packages/db` (Prisma schema and migrations), `packages/analytics` (ClickHouse DDL, ingestion, report queries), `packages/config-sync` (Redis snapshots the tracker reads), `packages/conversions` (conversion engine: payouts, attribution, postbacks, ledger), `packages/notifications` (in-app and email notifications).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full picture.

## Requirements

- Node.js 22+
- PostgreSQL 17, Redis 7, ClickHouse 25 (Docker Compose provided)

## Local setup

```bash
npm install
cp .env.example .env            # then fill ENCRYPTION_KEY, TRACKING_HASH_SECRET, SEED_ADMIN_*
docker compose -f infra/docker-compose.yml up -d
# No Docker? `npm run local:db` runs PostgreSQL from npm (Redis/ClickHouse still needed).

npx prisma generate --schema packages/db/prisma/schema.prisma
npm run db:deploy               # PostgreSQL migrations
npm run analytics:migrate       # ClickHouse tables
npm run seed -w @ntrack/api                # Nextagmedia org, system roles, first super admin
npm run seed -w @ntrack/api -- --demo      # optional DEMO DATA for local previews
```

Run the services (three terminals):

```bash
npm run dev:api        # http://localhost:4000
npm run dev:tracker    # http://localhost:4100
npm run dev:workers
```

Then run the website (`NTRACK_API_URL=http://localhost:4000 npm run dev` in the frontend repo) and open http://localhost:3000/ntrack/login.

**Local tracking domain.** Hostnames ending in `.localhost` skip DNS verification outside production. With `TRACKER_DEV_HOST_OVERRIDE=trk.localhost`, requests to `http://localhost:4100/c/<slug>` are served as `trk.localhost`. `node scripts/demo-traffic.mjs` sends real clicks through the tracker for DEMO links.

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | api, workers | PostgreSQL connection (`?connection_limit=` sets the pool size) |
| `REDIS_URL` | all | Config snapshots, click stream, queues, rate limits |
| `CLICKHOUSE_URL`, `CLICKHOUSE_DATABASE`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` | api, workers | Analytics store |
| `API_PORT` | api | Default 4000 |
| `CONSOLE_ORIGIN` | api | Exact origin of the console (e.g. `https://nextagmedia.com`). Requests with any other `Origin` are rejected |
| `DATA_EXPORT_DIR`, `DATA_EXPORT_TTL_DAYS` | api | Where privacy export archives are written (default `.local/exports`) and how many days they stay downloadable (default 7). Production: shared private storage |
| `CONSOLE_BASE_PATH` | api | Path of the console on that origin, default `/ntrack`; empty when the console has its own domain. Used for links in emails |
| `COOKIE_SECURE` | api | Must be `true` in production (enforced) |
| `COOKIE_PATH` | api | `/ntrack` in production so cookies only reach the console |
| `SESSION_TTL_HOURS` | api | Absolute session lifetime, default 12 |
| `ENCRYPTION_KEY` | api, workers | Base64 32-byte key for AES-256-GCM (MFA secrets, publisher tax/payment details) |
| `TRACKING_HASH_SECRET` | api, tracker | HMAC key for visitor fingerprints and hashed IPs. Same value on both |
| `TRACKER_CNAME_TARGET` | api | Hostname customers CNAME their tracking domains to |
| `TRACKER_PORT` | tracker | Default 4100 |
| `ALLOW_PRIVATE_OUTBOUND` | api, workers | Development only: postbacks may target localhost/private IPs. Refused in production |
| `TRUST_PROXY` | api, tracker | `true` only behind Cloudflare / a load balancer; enables `CF-Connecting-IP` and geo headers |
| `TRACKER_DEV_HOST_OVERRIDE` | tracker | Development only; refused in production |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME` | seed | First platform super admin |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | workers (API reads host/from only) | Email for notifications and scheduled reports. Unset = email off, in-app still works |
| `CONSOLE_ORIGIN` | workers | Also used by workers for links in emails |
| `DATACENTER_RANGES_FILE` | tracker | Optional path to the cloud IP range file; defaults to `packages/shared/data/datacenter-ranges.json` |
| `LOG_LEVEL` | all | pino level, default `info` |

Generate keys with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

## Scripts

| Command | |
|---|---|
| `npm run typecheck` | TypeScript across all packages |
| `npm test` | Unit tests (no infrastructure needed) |
| `npm run test:integration` | API integration tests against real PostgreSQL + Redis |
| `npm run build` | Production bundles in `apps/*/dist` |
| `npm run db:migrate` | Create a new Prisma migration (development) |
| `node scripts/update-datacenter-ranges.mjs` | Refresh AWS / GCP / Oracle IP ranges for the `datacenter_ip` flag |

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [API reference](docs/API.md)
- [Tracking, macros and transparent redirects](docs/TRACKING.md)
- [Security](docs/SECURITY.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Roadmap and status](docs/ROADMAP.md)
