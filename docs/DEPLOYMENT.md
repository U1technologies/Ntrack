# Deployment

Target layout (decided with the team; account details to be confirmed):

| Component | Where | Notes |
|---|---|---|
| Console UI | Vercel (existing Nextagmedia project) | `/ntrack/*` in the website repo; set `NTRACK_API_URL` |
| API | AWS ECS Fargate (or equivalent), 2+ tasks behind an ALB | `api.ntrack.nextagmedia.com`, private to Vercel's rewrite where possible |
| Tracker | AWS ECS Fargate, 2+ tasks, autoscaling on CPU/latency | Behind Cloudflare. Tracking domains CNAME to `TRACKER_CNAME_TARGET` |
| Workers | AWS ECS Fargate, 1–2 tasks | No inbound traffic |
| PostgreSQL | AWS RDS PostgreSQL 17, Multi-AZ, automated backups + PITR | |
| Redis | AWS ElastiCache Redis 7 with AOF, `noeviction` | Click stream must not be evicted |
| ClickHouse | ClickHouse Cloud (recommended) or self-managed | |
| TLS for customer domains | Cloudflare for SaaS (custom hostnames) | Certificates issued automatically per tracking domain |

## Build images

```bash
docker build -f infra/docker/Dockerfile --build-arg APP=api -t ntrack-api .
docker build -f infra/docker/Dockerfile --build-arg APP=tracker -t ntrack-tracker .
docker build -f infra/docker/Dockerfile --build-arg APP=workers --build-arg ENTRY=index.js -t ntrack-workers .
```

## Release steps

1. `npx prisma migrate deploy --schema packages/db/prisma/schema.prisma` (one-off task, before new API tasks start).
2. `npm run analytics:migrate` (one-off task).
3. Roll out workers, then API, then tracker.
4. First install only: `node dist/seed.js` in an API task with `SEED_ADMIN_*` set, then remove those variables.

## Production environment checklist

- `NODE_ENV=production`, `COOKIE_SECURE=true`, `COOKIE_PATH=/ntrack`, `CONSOLE_ORIGIN=https://nextagmedia.com`
- `TRUST_PROXY=true` only when traffic arrives through Cloudflare/ALB; restrict the tracker security group to Cloudflare IP ranges
- `ENCRYPTION_KEY`, `TRACKING_HASH_SECRET` from AWS Secrets Manager
- `TRACKER_DEV_HOST_OVERRIDE` unset (the tracker refuses to start otherwise)
- Vercel: `NTRACK_API_URL=https://api.ntrack.nextagmedia.com`
- Workers: `CONSOLE_ORIGIN` (links in emails) and `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` once an email provider is chosen (e.g. Amazon SES SMTP). Without them email is skipped and in-app notifications still work. Set `SMTP_HOST`/`SMTP_FROM` on the API too so the console can say email is on
- Tracker: refresh cloud ranges with `node scripts/update-datacenter-ranges.mjs` before building the image (or mount a file and set `DATACENTER_RANGES_FILE`)
- The API runs the scheduled-report scheduler (BullMQ, once per tick across replicas)

## Cloudflare

- DNS: `trk.nextagmedia.com` (and each customer domain via Cloudflare for SaaS) → tracker origin.
- Enable "Add visitor location headers" managed transform so the tracker receives `CF-IPCountry`, `CF-Region-Code`, `CF-IPCity`.
- WAF: rate limit `/c/*` per IP generously (e.g. 600/min) to blunt floods without hurting real traffic.
- Do not enable caching on `/c/*` (the tracker sends `no-store`).

## Monitoring

- Health: API `/health`; tracker `/health` (liveness) and `/ready` (Redis).
- Alert on: tracker p95 latency, 5xx rate, Redis memory, click stream length (`XLEN ntrack:stream:clicks` growing means workers are behind), dead-letter stream `ntrack:stream:clicks:dead`, BullMQ failed jobs, domain health failures, SSL expiry under 21 days.
- Logs are JSON (pino); ship to CloudWatch / your log platform. Cookies and auth headers are redacted.

## Capacity

No throughput figures are claimed yet. Before production: run load tests against the tracker (e.g. k6 at increasing RPS with realistic snapshots) and publish p50/p95/p99 latency and max sustained RPS per task. Run NTrack in parallel with Trackier on the same campaigns and compare click counts, duplicate handling, latency and uptime before migrating.
