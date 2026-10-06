# Deployment

The local stack uses Docker Compose. A production environment should run the web, API, and worker as separate deployable units with managed PostgreSQL, managed Redis, private object storage, a transactional email provider, centralized secrets, TLS, and structured-log ingestion. Configure `NODE_ENV=production`, an HTTPS `WEB_URL`, `API_URL`, and a randomly generated `SESSION_SECRET` of at least 32 characters; the API refuses to start in production without the session secret and web origin.

The application is not yet production deployable for real hiring decisions. The API refuses fake checkout in production, assessment submissions return unavailable, the worker refuses to start, and the seed script refuses to seed when `NODE_ENV=production`. These are fail-closed protections, not substitutes for the missing real provider integrations.

Before production: implement account registration/invitations and verified recovery/MFA; select reviewed AI, billing, email, calendar, and private-storage providers; review RBAC and tenant boundaries; configure backup and point-in-time recovery; isolate code execution; provision malware scanning; set retention schedules; validate domain and email ownership; run load, penetration, accessibility, and disaster-recovery tests; obtain legal and trademark review.

## Backup and restore

Take encrypted database backups and versioned object-storage snapshots. Test restore into an isolated environment at least quarterly. Restores must preserve audit, consent, and credit-ledger ordering.
