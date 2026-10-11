# Nova implementation milestones

Nova's target is the recruiter evidence-review and explicitly selected next-round invitation journey in the pasted goal. OAuth, autonomous hiring decisions, financial administration, destructive operations, voice, resume parsing, coding execution and production certification are excluded.

## Current local MVP status — October 9, 2026

October 10 assistant UX update: both the floating widget and full Nova page now start with a request, not a role/candidate form. Authorized job-title matching is conservative UI navigation; ambiguous or unknown jobs produce conversational choice cards. Evidence-only reviews retrieve up to five records with evidence in record order and disclose the batch limit. Candidate/round choices appear only for invitation requests, with nobody preselected. Approval and execution remain separate. The real local-model browser check now covers typing a job-specific review, a subsequent invitation request, explicit choices, approval and reload recovery; it passed in about 44 seconds on the observed run. Broader model quality remains a limitation: one observed model introduction contradicted the prepared-preview state, so prompts were tightened; proposal status and execution are controlled by the persisted server state, never that prose.

Fresh selected reports are the first available model tool phase, including follow-ups. Evidence-only runs close their tool phase after the requested reports have been retrieved; preparation closes its phase after a proposal exists. Final responses remain real, strictly validated model output with cited evidence. No generated summary fallback was added. All 73 API regression tests and 16 targeted runtime tests passed after these changes, with desktop/mobile assistant checks and web build/typecheck verification.

Ollama `qwen3.5:4b` is installed and explicitly configured for local-only inference on the M4 / 16 GB Mac. The real API/runtime acceptance and real desktop/mobile browser recruiter journeys passed, with cited fictional evidence, exact selection, no writes before human approval, one invitation/debit and saved outcome recovery. Lint, typecheck, tests and build pass. See [local setup](nova-local.md) and the [requirement-by-requirement acceptance audit](nova-acceptance.md) for current evidence and limits. Sections labelled historical checkpoint below record earlier progress, not current blockers.

## Milestone 1: shared invitation and approval foundations (historical checkpoint)

Implemented:

- Browser invitations use the shared `createAssessmentInvitation` transaction service, preserving tenant checks, live membership permissions, credit serialization, immutable ledger writes, configuration snapshots and idempotency.
- PostgreSQL records for Nova runs, tool calls and exact invitation proposals, including attempts, leases, cancellation, approvals, safe error codes and encrypted outcomes. Runtime use of the lease/retry fields is not yet implemented.
- Typed bounded tools: `list_roles`, `list_completed_assessments`, `read_assessment_report`, and `prepare_invitations`. These are internal functions, not exposed HTTP/MCP endpoints yet.
- Per-call tenant and permission validation. Reports expose criterion evidence and local report paths, but omit contact details, launch secrets and unrestricted submission blobs from model-facing output. Candidate evidence is marked untrusted; this is not a tested model-level prompt-injection defense by itself.
- Preparation must match the exact human-selected completed assessments and later active non-coding round. No candidate selection, ranking or hiring-decision tool is provided. Preparation has no invitation or credit effects.
- Ten-minute proposals bind actions, source/job/round/candidate/evidence context, credit balance, cost and expiry. Execution rechecks locked state and permissions; changed data invalidates approval.
- Approval and all invitation effects commit atomically. Repeated competing approval executes once and recovers the same encrypted links. Model-callable tools cannot execute approved invitations; the human approval entry point is separate and still needs a browser route/UI.

Verification: the existing API suite passed 35 tests after invitation extraction. Eleven new database integration cases passed for internal Nova tools, tenant isolation, untrusted evidence boundaries, explicit selection, competing execution, encrypted results, tampering, expiry, changed role/round/evidence/credits/existing invitations, permission revocation and cancellation. These tests are not yet a real-model or browser journey.

## Milestone 2: runtime, authenticated routes and request/reply UI

Implemented: configurable server-side HTTP adapters for Responses and Chat Completions protocols; bounded model/tool loops; validated typed arguments and cited response structures; persisted protocol transcripts and replay of committed tool results; 90-second ownership leases, three claim attempts and 20 model steps per run; cancellation, expired-owner recovery and safe error codes. API instances recover pending/due runs at startup and every 15 seconds when a model is configured. Browser-created runs retain their session binding; recovery checks current session and membership validity. Provider/model changes reject incompatible recovery. No fake model fallback exists.

The Ask Nova page supports role selection, explicit assessment/next-round selection, requests and cited responses, run traces, exact credit-cost approval and saved outcomes after reload. Reads and writes use authenticated browser sessions and workspace permissions; approval is not a model tool.

Follow-ups can continue an owned READY or COMPLETED review for the same role, retaining at most six earlier discussion turns and an 80,000-character context budget. Each follow-up is a new session-bound run with its own current explicit selection, fresh report tool calls, citation validation and approval. Raw protocol transcripts, proposal fingerprints and invitation outcomes are not inherited. Starting a follow-up supersedes the prior unexecuted proposal atomically; an executed invitation is not undone. Earlier discussion remains visibly labelled historical context. Select “Use this review for follow-up”, adjust the current selection/round, and enter the new question; choose “Start a new conversation instead” to omit prior context.

Verification: eight adapter tests use mocked HTTP, thirteen runtime/API integration tests use an explicitly injected test model, and thirteen tool/approval integration cases remain in place. Runtime coverage includes session and membership revocation while a model response is in flight, unauthenticated access, run ownership and cross-origin writes, competing claims, the four-run concurrency bound, expired-lease takeover and committed-proposal crash replay. Approval/preparation/cancellation share run-before-proposal lock ordering; tests race cancellation against both writes. JSONB-reordered tool arguments are compared through their typed schemas during replay. Publishing model output rechecks all three read permissions within a transaction, with authorization row locks. Four desktop/mobile browser checks passed using mocked API data; do not call them real-model end-to-end verification. None of these prove live model behavior.

The adapter's tool-call transcript handling follows [official function-calling documentation](https://developers.openai.com/api/docs/guides/function-calling). Actual provider/model compatibility and live safety behavior still need validation after a provider is chosen.

### Configure only after selecting a provider

The user selected local inference on an M4 / 16 GB Mac: Ollama with `qwen3.5:4b`. The explicit loopback-only profile, successful real-model checks and startup instructions are in [local Nova setup](nova-local.md). Historical provider-pending notes below describe the earlier checkpoint.

Latest follow-up checkpoint: the runtime suite now has fourteen cases, all 70 API regression tests pass, four desktop/mobile Nova browser checks pass (including follow-up interaction), and `corepack pnpm check` passes lint, typecheck, unit tests and build. The authenticated follow-up fixture verifies fresh report retrieval, saved discussion, same-role/ownership validation and rejection of the superseded approval. These remain injected-model/mocked-API checks, not live-model acceptance.

Set API-server variables `NOVA_PROVIDER` (`responses` or `chat-completions`), `NOVA_BASE_URL` (the provider's API base, including its version path), `NOVA_MODEL` (an explicit model compatible with that protocol), and `NOVA_API_KEY`. No default vendor, endpoint, model or paid call is selected. Use a trusted HTTPS endpoint; HTTP is accepted only for loopback development endpoints. Configuration is server-side, never `NEXT_PUBLIC_*`. The application does not automatically load a root `.env`; export variables in the API process environment and restart that service.

Missing or invalid settings disable Nova request execution and proposal approval, while authorized users can still inspect saved runs. For a chosen OpenAI endpoint, use its Responses API for models that require it; not every current model supports Chat Completions tool calling. Compatible third-party endpoints must implement the selected protocol and JSON/tool-call contracts. Keep `NOVA_RESULT_ENCRYPTION_KEY` stable to recover encrypted launch links.

After configuring, open `/workspace/copilot`, choose a role, select one completed assessment per intended candidate and a later active non-coding round, then ask Nova to review and prepare those invitations. Review linked evidence and the exact proposal. Check the explicit approval box and approve only when the recipients, round and total credits are correct. Saved runs recover committed outcomes; cancellation cannot undo executed invitations.

### Historical pending list at the pre-provider checkpoint

- Live chosen-model recruiter journey and adversarial model evaluation: provider choice, credentials and permission for paid verification are still needed.
- A complete requirement-by-requirement final audit, including live-model verification.
- MCP is omitted under the conditional safety requirement: current workspace API keys lack a user-bound Nova selection/approval identity. See the explicit [MCP decision and acceptance audit](nova-acceptance.md). No unsafe impersonation bridge or model-callable human approval endpoint is provided.
- Candidate content is isolated as data and unavailable tools cannot execute, but a valid citation ID does not prove a model's factual interpretation or fairness. Human review and stronger model-level evaluations remain required.

## Original milestone checklist (not completion claims)

1. Configurable real model adapter, bounded model/tool loop, structured cited responses, runtime ownership fencing, persisted traces, bounded retries and cancellation/recovery. Missing credentials must fail clearly; no automatic fake model fallback.
2. Authenticated session-bound Nova routes and conversational UI replacing the preview. Explicit candidate/round selection and exact human approval must be clear and recoverable after reload.
3. Provider failure and model-level prompt-injection tests, authenticated route coverage, real browser journey, existing workflow regressions and real configured-model verification.
4. Non-OAuth MCP only if it can safely share the same authorization and approval boundary; never treat an external model tool call as human approval.
5. Setup instructions, walkthrough and requirement-by-requirement completion audit.

At that checkpoint no provider/model had been chosen. Local Ollama has since been chosen and verified; no paid model calls or external deployment have been made. Do not paste secrets into chat; configure them only in the server environment.

## Local schema and tests

Migrations `20261008110000_nova_agent_records`, `20261008113000_nova_runtime_state`, `20261008114000_nova_session_binding` and `20261008120000_nova_followups` add the agent records and runtime/session/conversation fields. Generate the Prisma client and deploy migrations before running integration checks.

Run `ACCOUNT_FLOW_INTEGRATION=1 corepack pnpm --filter @northstar/api exec vitest run src/nova-tools.integration.test.ts src/nova-runtime.integration.test.ts src/nova-provider.test.ts` against local PostgreSQL. Tests create fictional organizations and users and remove only those exact fixtures.

Invitation result encryption will use `NOVA_RESULT_ENCRYPTION_KEY`, a stable secret of at least 32 characters in production. A known local-development fallback exists only for fictional local data. The key is not a model API key. Lost keys make saved invitation links unreadable; keys and encrypted result retention/rotation need operational policy before production use.
