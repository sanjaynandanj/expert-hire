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

The live assessment journey creates a unique fictional candidate and role with three authored written questions on each run. After issuing the invitation, it edits only that role's live rubric/questions/type (to coding) and verifies that the already-issued written assessment still opens with its original prompts. It waits for a server draft save, reloads and verifies the restored answer, submits with the latest draft revision, and follows that candidate's completed report. History labels and worker evidence must use the original round/rubric. No coding execution occurs. Unlike disposable API integration fixtures, live UI journeys retain fictional workspace records, credit debits, and audit history in the local seed database. Run only against the development stack, never production.

Unit tests cover domain rules, deterministic scoring, provider behavior, session token integrity, and API authentication boundaries. The remaining API, database, browser, accessibility, and provider paths need broader automated coverage before production use.

The opt-in account/product integration suite requires migrated local PostgreSQL and Redis, uses disposable fictional fixtures, and cleans up its own records:

```bash
ACCOUNT_FLOW_INTEGRATION=1 corepack pnpm --filter @northstar/api test
```

It covers account lifecycle, MFA, developer-platform workflows, student corrections/notifications, and competing placement application/offer decisions. Metrics unit tests cover bounded route labels, cumulative histograms, bearer authentication, and omission of candidate IDs/query strings. These tests do not certify a deployed monitoring stack or production provider integrations.

Webhook tests also exercise simulated queue rejection/timeouts, candidate/event/audit rollback, subscribed versus inactive endpoints, concurrent candidate upserts, no-op event suppression, and competing replays. No real external webhook is sent by these fixtures. Public-list tests traverse more than 100 tied-timestamp records and reject foreign, hidden, and deleted cursors.

Workflow event integration checks cover pipeline assignments/moves, meetings, both student/staff application paths, concurrent assessment completion, completion rollback, and competing inline submissions. API and worker share the same completion transaction. This does not replace a real worker/receiver outage-and-restore exercise in the selected production environment.

The webhook lease integration suite uses a disabled fictional endpoint and an injected clock. It checks competing worker claims, rejected foreign/expired ownership tokens, crash recovery, late results after takeover, preserved retry budgets through six simulated crashes, active leases, future retry times, and legacy processing rows. Recovery is scoped to the fixture endpoint; cleanup removes only its disposable organization. These database tests do not send external requests or certify exactly-once delivery.

Webhook deadline unit tests use mocked DNS/HTTPS and fake timers to check stalled and late DNS results, registration validation timeouts, the shared DNS/request budget, socket abort signals, response-body disposal for success/error/redirect statuses, timer cleanup, and invalid timeout bounds. These tests do not replace deployed-network TLS/egress tests.

Candidate-session integration tests exercise every candidate action with expired tokens and disabled coding rounds, verify unchanged assessments/no integrity writes on rejection, check uncached responses, and race assessment starts. They also check preserved consent/start timestamps and rejection of integrity writes after submission. Fixtures use a dedicated fictional organization; account-flow cleanup targets only that run's exact user emails.

Draft integration tests cover partial-answer restoration, cross-device competing revision writes, stale submission rejection, final submission/cleared draft, closed/pre-consent sessions, and input size limits. `tests/e2e/assessment-drafts.spec.ts` uses mocked API responses on desktop/mobile to verify authored questions, elapsed-time restoration, persisted answers across pages, final submission revisions, and explicit conflict recovery while preserving typed text. Browser mocks complement—not replace—the PostgreSQL integration suite.

Round-retirement API checks cover tenant isolation, blocking new invitations without credit debits, unchanged existing candidate access/consent/start/report retrieval, audited no-ops/restoration, stale-state rejection, and invitation-versus-retirement races. `tests/e2e/round-retirement.spec.ts` checks retire/restore controls and invitation-option filtering with mocked API data on desktop/mobile.

Invitation integration checks race identical idempotency keys, asserting one assessment/debit/audit and a replay without a new launch URL. They reject changed round/expiry requests and other-purpose ledger-key collisions, race distinct rounds to verify the exact remaining credit balance, and ensure insufficient-credit requests leave no assessment or ledger row.

Readiness unit tests use fake timers and mocked dependencies to check caller deadlines, shared operations after timeout, cleanup/recovery after errors, Redis failures after queue initialization, unexpected PING responses, and independent liveness during outages. The opt-in account-flow suite also checks healthy readiness against local PostgreSQL and the real BullMQ Redis backend. These checks do not certify production outage recovery or monitoring deployment.

Configuration snapshot tests verify detached copies, frozen fallback prompts, preservation of coding guards, explicit legacy fallback, and rejection of malformed stored snapshots. API integrations edit a role/rubric/round after invitation, then check the original candidate prompts, report context, unchanged stored configuration, and inline evidence criterion/weight. The live browser journey additionally verifies original rubric evidence produced by the actual local Redis worker after configuration changes, and original assessment-history labels. A deployed production exercise and independent assessment review remain unverified.

Nova adapter tests mock HTTP protocol responses; Nova runtime integrations inject a clearly named test model and use real local PostgreSQL/session routes. Coverage includes typed tool boundaries, evidence citations, explicit selection, tampering/expiry/stale context, competing approval, crash replay, cancellation, bounded provider retries, session/membership revocation during a provider call, ownership and cross-origin access. `tests/e2e/nova-copilot.spec.ts` checks unavailable configuration and review/approval/reload on desktop/mobile using mocked API data. These checks do not prove a real model's reasoning, injection resistance or fairness; chosen-provider end-to-end and adversarial verification are still pending.

Recovery tests also race eight processors for one run, verify only four simultaneous claims across six distinct runs, replace an expired live owner and reject its late output, and replay a committed invitation proposal after simulated transcript-save failure without another proposal or debit. Tool tests race cancellation against both approval and re-preparation, asserting complete execution or complete cancellation rather than partial effects. These are local database concurrency checks, not production load certification.

When reusing a dev server started with a localhost API URL, run live browser checks with matching web/API hostnames: `LIVE_API_E2E=1 PLAYWRIGHT_BASE_URL=http://localhost:3000 NEXT_PUBLIC_API_URL=http://localhost:4000 corepack pnpm exec playwright test tests/e2e/live-api.spec.ts --project=chromium --workers=1`. Mixing localhost and 127.0.0.1 can discard cross-site session cookies; parallel repeated logins can exceed the existing ten-per-minute login limit. Do not weaken cookie or rate-limit protections to make the suite pass.

Real-model Nova acceptance is a separate opt-in suite with two explicit approval switches, documented in [Nova acceptance](nova-acceptance.md). Normal runs skip it and incur no model charges.
