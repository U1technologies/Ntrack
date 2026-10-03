# Security

## Authentication and sessions

- Passwords: argon2id (19 MiB, t=2). Minimum 12 characters with letters and numbers. Unknown emails take the same time as wrong passwords.
- Lockout: 10 failed attempts → 15-minute lock. Login is also rate limited per IP (IPv6 grouped by /56) and email.
- Sessions: random 256-bit token in an `httpOnly`, `SameSite=Lax`, `Secure` (production) cookie scoped to `/ntrack`. Only the SHA-256 hash is stored. Absolute lifetime `SESSION_TTL_HOURS`. Password changes and MFA enablement revoke other sessions.
- MFA: TOTP (RFC 6238). Secrets encrypted with AES-256-GCM. Organizations can require MFA; users without it can only reach the MFA setup screen.
- The NTrack console uses separate accounts from the Nextagmedia website admin.

## Request protection

- CSRF: double-submit token (`ntrack_csrf` cookie echoed in `X-CSRF-Token`) on every state-changing request, including login, plus an exact `Origin` check against `CONSOLE_ORIGIN`.
- No CORS: the console reaches the API through a same-origin rewrite.
- Helmet headers; API responses use a `default-src 'none'` CSP.
- Input validation: Zod schemas on every body and query; failures return field-level errors.
- SQL injection: Prisma parameterised queries; ClickHouse queries use whitelisted columns and bound parameters only.
- Rate limits: 600 req/min per IP on the API, 10/15 min on login and MFA, 20/min on network tools; Redis-backed for multiple replicas.

## Invitations and password reset

- Invitation (7 days) and reset (30 minutes) tokens are 256-bit random, stored as SHA-256 only, single use (claimed atomically), and sent to the API in request bodies, not URLs.
- The forgot-password endpoint answers identically for unknown emails; requests are rate limited per IP and email, token use per IP.
- A pending invitation grants nothing; the membership is created on acceptance. Existing users must confirm their current password to accept. Accepting never creates a session, so MFA still applies at sign-in.
- Every password change (self-service, reset link, admin reset) signs out other sessions and emails a notice.
- Restricted managers can only add users for advertisers or publishers in their own scope, and never with more permissions than they hold.

## Authorization

- Permissions are `module.action` keys checked by `requirePermission` on every route.
- Data-level scopes (advertiser, publisher, managed) are applied inside services via `services/access-scope.ts`. Filters are wrapped in `AND` so they can never be overwritten by search filters (covered by regression tests).
- Users cannot grant roles or permissions they do not hold (privilege escalation tests).
- Publishers never receive revenue rates; advertisers never receive publisher payouts.
- Notifications resolve recipients inside the event's organization and data scope (staff, managed assignments, or the partner the event is about), so a notification cannot reveal a record its recipient could not open. Partner-facing notifications never include revenue.
- Scheduled reports are generated separately for each recipient with that recipient's own permissions and scope; recipients must be members with `reports.view`.
- Finance: payouts follow a four-eyes rule (requester cannot approve); ledger journals are append-only (`onDelete: Restrict`); fraud enforcement actions are explicit choices by a reviewer and audited.

## Redirect and outbound safety

- Open redirect prevention: destinations must be http(s), credential-free, hostname-based and on the campaign allowlist. Landing page templates cannot contain macros in the host. Final URLs are re-validated after macro rendering.
- SSRF: all outbound HTTP (health checks, RDAP, redirect tester, future postbacks) goes through `safeRequest`, which validates the resolved IP inside the socket's DNS lookup (no rebinding window), blocks private/reserved ranges, never follows redirects automatically, and caps body size and time.
- The redirect tester only accepts URLs on the caller's own tracking domains.

## Data protection

- Encrypted at rest (application layer): MFA secrets, publisher tax info and payment details (`ENCRYPTION_KEY`). Card numbers are never accepted.
- Audit log for every create/update/delete, login, failed login, MFA change and tool run. Sensitive keys are redacted before logging.
- IPs truncated before storage in sessions, audit logs and (by default) clicks.
- Personal data in scope for GDPR / India DPDP / CCPA: user accounts, publisher and advertiser contacts, tax/payment details, click IPs and user agents.
- Data subject requests: Settings → Privacy requests (export or erase users, publishers, advertisers; whole-organization export). Erasure needs a second person's approval, anonymises rather than deletes, and keeps records needed for accounting and tax. Issued invoices freeze the advertiser's billing details at issue time, so erasure never alters them. Every person can download their own data or ask for account deletion from Security settings.
- Export archives are written with owner-only permissions, are downloadable for 7 days and are then removed by an hourly sweep. In production they must live on shared private storage (S3 with encryption and a lifecycle rule) because API replicas do not share disks.
- Not yet automated: enforcing each organization's click retention setting (it would delete analytics data, so it waits for an explicit decision), and erasing a whole organization. Someone at Nextagmedia should own privacy sign-off before launch.

## Secrets

- All secrets come from environment variables; `.env` is git-ignored; nothing secret is sent to the browser or embedded in tracking links.
- Rotate `ENCRYPTION_KEY` by adding a `v2` key and re-encrypting (payload format is versioned). Rotating `TRACKING_HASH_SECRET` resets unique-click detection for the window.

## Known gaps (tracked in ROADMAP.md)

- PostgreSQL row-level security as a second isolation layer (isolation is currently enforced in the service layer and tested).
- Email delivery needs a provider (SMTP). Invitations and password reset are built; until SMTP is configured, admins share invitation links manually and self-service reset emails are not delivered.
- Spreadsheet exports neutralize formula-like cells (`= + - @`). `exceljs` pulls in a `uuid` version with a moderate advisory that does not affect how exceljs uses it; Prisma CLI tooling carries high-severity advisories in `deepmerge-ts` (build-time only). Re-check `npm audit` before launch.
- API keys / OAuth for partner integrations (Phase 4).
- Penetration test before commercial launch.
