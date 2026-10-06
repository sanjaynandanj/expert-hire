# Northstar Talent OS

Northstar is a greenfield talent-intelligence platform for employers, staffing teams, universities, and candidates. It keeps job criteria, assessment evidence, human review, placement operations, and preparation history in one tenant-scoped system.

> **Naming notice:** Northstar is a temporary product name. It has not been evaluated or cleared for trademark use.

## Current implementation

- Original responsive public website and brand system
- Employer workspace dashboard, ATS pipeline, jobs, candidates, meetings, clients, placements, analytics, copilot, campus, and settings surfaces
- Candidate practice dashboard
- Fastify `/v1` API with OpenAPI, rate limiting, security headers, structured errors, health checks, tenant scoping, job creation, and audit writes
- Password login and tenant-scoped workspace APIs for jobs, candidates, assessment invitations, reports, credits, and university placement
- Redis/BullMQ assessment evaluation worker with a deterministic local-only provider
- Prisma/PostgreSQL domain model covering tenancy, RBAC, jobs, rounds, assessments, evidence, integrity events, staffing clients, credits, campus placement, API keys, and webhooks
- Deterministic assessment state-transition and job-validation tests
- Docker Compose definitions for PostgreSQL, Redis, an S3-compatible object store, and Mailpit
- Fictional seed organizations, users, clients, candidates, assessments, campus data, a drive, and an offer

See [docs/known-limitations.md](docs/known-limitations.md) for the honest boundary between implemented and planned behavior.

## Quick start

Prerequisites: Node.js 24+, Corepack/pnpm, and Docker Desktop.

```bash
cp .env.example .env
corepack pnpm install
docker compose up -d
corepack pnpm db:generate
corepack pnpm db:migrate
corepack pnpm db:seed
corepack pnpm dev
```

Open:

- Web: http://localhost:3000
- API: http://localhost:4000
- OpenAPI UI: http://localhost:4000/docs
- Mailpit: http://localhost:8025
- Object storage S3 endpoint: http://localhost:8333
- Object storage filer/admin UIs: http://localhost:8888 and http://localhost:23646

## Demo accounts

All local demo accounts use password `NorthstarDemo!`.

| Role | Email |
|---|---|
| Employer owner | `owner@acmeworks.test` |
| Staffing owner | `recruiter@astersearch.test` |
| University placement owner | `placements@riverton.test` |
| Student | `student@riverton.test` |

Password login uses a seeded local account and sets a signed session cookie. Account verification, reset, OAuth, MFA, and session revocation are not implemented; see the known limitations before production use.

## Commands

```bash
corepack pnpm dev          # run all development services
ASSESSMENT_PROCESSING_MODE=queue corepack pnpm dev # use Redis for assessment scoring
corepack pnpm typecheck    # strict TypeScript validation
corepack pnpm test         # unit and API tests
corepack pnpm build        # production builds
corepack pnpm check        # lint/typecheck/test/build gate
corepack pnpm infra:up     # local backing services
corepack pnpm db:migrate   # database migration
corepack pnpm db:seed      # fictional demo data
```

## Repository map

```text
apps/
  api/        Fastify API
  web/        Next.js public and authenticated experiences
  worker/     BullMQ assessment worker
packages/
  brand/      centralized brand configuration
  database/   Prisma schema, client, and seed
  domain/     portable validation and business rules
  providers/  evaluation, billing, storage, speech, and transcription interfaces
docs/         product, architecture, security, and operating documentation
```

No Expert Hire source code, copy, screenshots, customer data, or brand assets are used in this project.
