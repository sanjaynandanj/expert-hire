# Local implementation handoff

This is a working development checkpoint, not completion of the full production goal. OAuth is excluded. Nova's configurable runtime, evidence tools and human-approved invitation UI are implemented; live-model verification remains pending. See [Nova setup and walkthrough](nova.md).

## Implemented locally

Recruiting roles, weighted round plans, candidates, pipeline management, invitations, written assessments and evidence reports; staffing clients, commercial terms, placements and manual invoice tracking; university seasons, drives, eligibility, applications, offers, academic-profile review and in-app notifications; private student text practice; registration, verification, password recovery, workspace invitations, revocable sessions and optional MFA; scoped public API keys, signed webhooks with durable recovery; monitoring and encrypted backup/restore foundations.

Recent reliability work includes assessment configuration snapshots, revision-controlled candidate drafts, concurrent credit/idempotency guards, recoverable queued input with ownership fencing and database retry budgets, and the trusted-origin login correction. These are foundations, not production assessment validation.

## Run and use

Start infrastructure with `docker compose up -d`. In separate terminals run `corepack pnpm --filter @northstar/web dev`, `corepack pnpm --filter @northstar/api dev`, and `corepack pnpm --filter @northstar/worker dev`.

Use http://localhost:3000/login and keep browser/API hostnames consistent. API readiness is http://localhost:4000/ready; worker readiness is http://localhost:4001/ready; local email capture is http://localhost:8025. Demo accounts and their shared development password are in [README](../README.md). Do not use fictional credentials or local development secrets in production.

## Verification

The standard check is `corepack pnpm check` (lint, typecheck, unit tests and build). Database/Redis integrations run with `ACCOUNT_FLOW_INTEGRATION=1 corepack pnpm --filter @northstar/api test`. The real-worker recovery test runs with `WORKER_RECOVERY_INTEGRATION=1 corepack pnpm --filter @northstar/worker test` and checks database-only submissions and expired ownership. Integration fixtures are fictional and cleaned up by exact organization/account identifiers. Production infrastructure recovery and independent review are not covered by these checks.

## Deferred, not completed

- Nova live-provider verification and adversarial model evaluation. Follow-up context is implemented with fresh evidence checks and separate approvals. MCP is not exposed through organization API keys; those keys lack the user-bound approval identity required by Nova.
- Resume uploads/parsing, production assessment AI, voice/transcription/video, meeting bots and calendar integration.
- Dedicated isolated coding execution infrastructure and independent security review. Coding remains fail-closed.
- Production billing/accounting, tax-compliant documents, reconciliation and replacement-guarantee policy.
- Private production file storage, signed URLs, malware scanning and lifecycle rules.
- Production notification configuration, assisted lost-MFA recovery policy, controlled external report sharing and historical analytics.
- Deployment, managed secrets, scheduled/offsite backups, deployed alert routing, candidate-data retention policy, load/accessibility/security/legal reviews and final brand clearance.
- Browser extension and desktop app.

No provider subscriptions, external deployment or production certification is implied. Working changes remain uncommitted; no commit or broad cleanup is performed as part of this handoff. See [progress](progress.md) and [limitations](known-limitations.md) for details.
