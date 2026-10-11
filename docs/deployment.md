# Deployment

The local stack uses Docker Compose. A production environment should run the web, API, and worker as separate deployable units with managed PostgreSQL, managed Redis, private object storage, a transactional email provider, centralized secrets, TLS, and structured-log ingestion. Use a `rediss://` `REDIS_URL` for managed Redis with TLS; API and worker queues plus worker health probes honor it. Configure `NODE_ENV=production`, an HTTPS `WEB_URL`, `API_URL`, `EMAIL_FROM`, `RESEND_API_KEY`, and independently generated `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`, and `WEBHOOK_ENCRYPTION_KEY` values of at least 32 characters; the API refuses to start in production without these secrets and the web origin. API `GET /health` and worker `GET /health` are dependency-free liveness checks. API `GET /ready` and worker `GET /ready` check PostgreSQL and Redis and return 503 when dependencies are unavailable; the worker also verifies that webhook delivery is running. Expose worker health on a private service network only (`WORKER_HEALTH_PORT`, default 4001; `WORKER_HEALTH_HOST`, default `0.0.0.0`). Keep encryption keys stable and backed up: rotation requires users to re-enroll MFA and webhook endpoints to be reconfigured.

The application is not yet production deployable for real hiring decisions. The API refuses fake checkout in production, assessment submissions return unavailable, and no assessment-evaluation worker is started in production; webhook delivery can still run. The seed script refuses to seed when `NODE_ENV=production`. These are fail-closed protections, not substitutes for the missing real provider integrations.

Before production: independently review account, API-key, webhook, and recovery security; implement OAuth if required; select AI, billing, calendar, and private-storage providers and supply their credentials; provision a real coding sandbox rather than running submitted code in application processes; configure backup/restore, malware scanning, retention and monitoring; validate domain and email ownership; run load, penetration, accessibility, and disaster-recovery tests; obtain legal and trademark review.

## Monitoring

For private metrics collection, configure a dedicated `METRICS_TOKEN` (at least 32 characters) in API and worker and follow [operations monitoring](monitoring.md). Exporters and example alerts are implemented; a collector, alert routing, and separate readiness probes still need deployment.

## Backup and restore

Take encrypted database backups and versioned object-storage snapshots. Test restore into an isolated environment at least quarterly. Restores must preserve audit, consent, and credit-ledger ordering.

Use the [encrypted backup and isolated restore-drill tooling](backup-and-restore.md) as a verified logical-backup foundation. A local fictional-data drill matched ordered audit, consent/assessment, credit-ledger, and evidence records. Production scheduling, off-host retention, key escrow, WAL/snapshot recovery, and private-object-storage backups still require operator setup.

The worker's daily ephemeral-retention task uses `EPHEMERAL_RETENTION_GRACE_DAYS` (default 30, valid range 1–365) for expired sessions, account tokens, invitations, and used recovery codes. It only clears expired launch tokens on pending assessments; it does not purge candidate or assessment content. Confirm this operational grace period with security/legal owners, then define separate retention and deletion schedules for candidate data, transcripts, practice responses, and audit records before onboarding real users.
