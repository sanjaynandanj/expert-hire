# Implementation progress

This checklist tracks the greenfield Northstar build against the product brief. “Implemented” means a working foundation or verified workflow, not production certification.

- [x] Monorepo, package management, TypeScript, build orchestration, and CI workflow
- [x] Centralized temporary brand and original visual system
- [x] Local PostgreSQL, Redis, S3-compatible storage, and mail capture
- [x] Relational model and deterministic fictional seed data
- [x] Original responsive public website and product information pages
- [x] Employer dashboard, API-backed jobs, talent pool, search, pipeline movement/stage creation, assessment invitations, and reports
- [x] Candidate practice surface with persisted private practice attempts, advisory feedback, and readiness history
- [x] University placement overview, roster, eligibility previews, student self-applications, drive authoring/publication, application review, offers, and outcome history
- [x] Password login, signed session cookie, membership checks, server-side permission checks, and demo roles
- [x] Tenant-scoped dashboard, jobs, candidates, assessments, clients, credits, student practice, and placement API routes
- [x] Assessment credit debit, idempotent invitation creation, expiring hashed launch tokens, consent, integrity context, submission, and evidence-linked evaluation
- [x] BullMQ/Redis assessment worker with retries and deterministic local evaluator
- [x] Audit writes for candidate/job/invitation, client terms, pipeline stages, practice, and placement actions
- [x] Domain/provider/API unit tests plus desktop/mobile and live-data Playwright journeys
- [x] Local migration and seed run against PostgreSQL
- [x] Organization switching UI for memberships granted to the signed-in user
- [x] Client creation/status, pipeline stage API CRUD, role status/rubric/round-plan APIs, and placement/offer state transitions
- [ ] Account lifecycle: invitations, verification, reset, session revocation, and MFA
- [ ] Candidate notes, meeting scheduling/attendance, full stage/job/client editing UI, member administration, and workspace settings
- [ ] Staffing placement attribution, fee calculation from starts, invoices, guarantees, and reconciliation
- [ ] University season/company management, bulk imports, offer caps/outcome reconciliation, and richer student self-service
- [ ] Production AI, speech, transcription, email, billing, storage, and identity provider adapters
- [ ] API-key management, public API sandbox/live keys, signed webhook delivery, and replay
- [ ] Secure coding execution sandbox
- [ ] Nova tool server/MCP package, browser extension, and desktop shell
- [ ] Production observability, backups, retention jobs, performance, accessibility, and independent security review
- [ ] Trademark clearance for Northstar name and final brand assets
