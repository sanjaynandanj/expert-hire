# API

The Fastify API runs at `http://localhost:4000`; interactive OpenAPI documentation is at `/docs`.

Implemented route groups:

- Health: `GET /health`, `GET /ready`
- Authentication: `POST /v1/auth/login`, `POST /v1/auth/logout`, `GET /v1/auth/session`
- Workspace: `GET /v1/workspace`, `GET /v1/dashboard`
- Jobs, candidates, and clients: `GET/POST /v1/jobs`, `PATCH /v1/jobs/:jobId`, `GET/POST /v1/candidates`, `GET/POST/PATCH /v1/clients`
- Pipeline: `GET/POST /v1/pipeline/stages`, `PATCH/DELETE /v1/pipeline/stages/:stageId`, `POST /v1/candidate-jobs`, `PATCH /v1/candidate-jobs/:candidateJobId/stage`
- Assessments: `GET/POST /v1/assessments`, `GET /v1/assessments/:assessmentId`
- Candidate session: `GET /candidate/assessments/:token`, consent, start, integrity-events, and submit actions
- Credits: `GET /v1/credits`, `POST /v1/credits/checkout` (local fake checkout only)
- Student preparation: `GET /v1/student/practice`, `POST /v1/student/practice/attempts`, `GET /v1/student/drives`, `POST /v1/student/applications`
- Campus placement: drive configuration/authoring/status, overview, students, eligibility, applications, application review, offers, and offer outcomes under `/v1/placements`

Authenticated workspace routes require an `X-Organization-Id` header. The API verifies membership and permission on the server before querying tenant data. Candidate launch URLs use 256-bit random tokens; only their SHA-256 hashes are stored, they expire, and successful completion invalidates them.

Errors use `{ error: { type, code, message, request_id } }`. Route-level validation is enforced with Zod. The global request ceiling is configurable with `API_RATE_LIMIT_MAX`; it defaults to 1,000/minute in development and 150/minute in production, while login has a stricter route-level limit. API-key authentication, public sandbox/live keys, cursor pagination, webhook delivery/signatures, and complete event versioning remain unimplemented.
