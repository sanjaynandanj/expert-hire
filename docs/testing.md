# Testing

Local gates:

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm test:e2e
```

The default Playwright suite checks the responsive public site, workspace routes, practice surface, demo assessment runtime, and demo report on desktop Chromium and mobile emulation.

Live browser journeys require Docker services, a migrated and seeded PostgreSQL database, the API, and (for queued scoring) the worker:

```bash
LIVE_API_E2E=1 corepack pnpm exec playwright test tests/e2e/live-api.spec.ts
```

That suite signs in with fictional employer and university accounts, creates a candidate, records a placement application, issues a secure assessment invite, submits candidate answers, and opens the stored report after the Redis worker completes.

Unit tests cover domain rules, deterministic scoring, provider behavior, session token integrity, and API authentication boundaries. The remaining API, database, browser, accessibility, and provider paths need broader automated coverage before production use.
