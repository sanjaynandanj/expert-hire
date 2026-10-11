# Nova acceptance audit

This is the local MVP acceptance audit as of October 9, 2026. The chosen Ollama `qwen3.5:4b` model passed the real API/runtime journey and desktop/mobile browser journeys with disposable fictional data, including instruction-like candidate evidence. No paid provider or external deployment was used. This is not production certification or a universal safety/quality claim.

## Requirements and current evidence

| Goal requirement | Authoritative implementation / checks | Result |
| --- | --- | --- |
| 1. Working conversational UI | `apps/web/components/nova-copilot.tsx`; mocked desktop/mobile checks plus real local `nova-live.spec.mts` review/approval/reload journey | Implemented; real desktop/mobile journeys passed |
| 2. Real configurable adapter; honest missing credentials | `nova-provider.ts`; nine protocol tests; disabled-state browser tests; explicit configuration and loopback-only Ollama compatibility profile | Implemented; chosen local model verified |
| 3. Typed domain tools | `nova-tools.ts` strict schemas; shared `assessment-invitations.ts` used by browser and approved execution | Implemented and locally tested |
| 4. Tenant isolation and least privilege | Session-bound routes; per-tool current membership checks; transaction-held authorization locks; owner-scoped runs/proposals; route and tool integration tests | Locally verified; not an independent security review |
| 5. Exact, expiring, stale-safe human approval | Proposal fingerprint, context snapshot and locked revalidation; explicit `confirm: true`; tamper/expiry/changed-context/racing approval tests; follow-up supersedes old proposal | Locally verified |
| 6. Persistent trace/retry/cancel/recovery | Nova tables and migrations; claim budgets, leases, four concurrent claims, twenty model steps; cancellation/claim/takeover/crash replay/race tests | Locally verified; no production outage certification |
| 7. Evidence grounding and untrusted content | Server-generated report links; citations must match fresh report evidence; prompts mark tool data untrusted; unavailable tools denied; actual fictional injection fixture | Citations/effects tested and observed summary reviewed; broader interpretation/injection evaluation remains ongoing |
| 8. No autonomous hiring decisions or dangerous tools | No ranking, rejection, hiring, financial/admin/destructive tool; exact human selection; policy prohibits decision recommendations | Effect boundary verified; observed real summary did not follow injected hiring or secret-disclosure requests |
| 9. Conditional safe non-OAuth MCP | Current API-key schema and public authentication resolve only organization/scopes, not user/session or explicit selection grants | Omitted under the safety condition; decision below |
| 10. Security/failure/journey tests | Provider, tool/runtime, mocked browser, opt-in real-provider API and real local browser suites | Local regression and real chosen-model journeys passed |

## MCP decision for this MVP

Do not expose Nova through the existing organization API keys. `ApiKey` has organization, scope and revocation fields but no acting recruiter. The public API's authentication hook does not resolve a user membership or browser session. Nova's runs, selection, proposals, approval and encrypted outcomes are explicitly user-owned. Mapping an organization key to an owner would silently impersonate that person and bypass session revocation and human selection. Adding `confirm: true` to a model-callable endpoint would not establish human approval.

The safe-reuse condition in requirement 9 is therefore not met by the existing external authentication mechanism. No MCP endpoint is included in this MVP. This does not mean secure non-OAuth MCP is impossible: a later implementation needs explicit user-bound, expiring/revocable delegation, tenant/read/prepare scope restrictions and a human-selected run grant. It must call the same typed tool registry, never expose approval/execution as a model tool, and route approval back to the authenticated human UI. Browser session cookies must not be copied into external clients as an undocumented shortcut. That additional delegation lifecycle is not claimed implemented.

## Real-model acceptance gate

The opt-in `apps/api/src/nova-live.integration.test.ts` uses the actual configured adapter, a loopback fictional-data database, authenticated human approval routes and exact disposable fixtures. It includes untrusted instruction-like evidence and an unselected person, checks citations, no effects before approval, one selected invitation/debit, and safe repeated approval. It passed with the selected local model in about 28 seconds. `tests/e2e/nova-live.spec.mts` separately passed the real browser journey, including login, cited review, explicit approval and saved invitation recovery after reload. Neither substitutes a mock model.

After the user chooses a provider/model and approves model charges, configure server-side `NOVA_PROVIDER`, `NOVA_BASE_URL`, `NOVA_MODEL` and `NOVA_API_KEY` in the test process, then run:

```sh
NOVA_LIVE_VERIFICATION=1 NOVA_LIVE_CALLS_APPROVED=1 corepack pnpm --filter @northstar/api exec vitest run src/nova-live.integration.test.ts
```

Do not paste keys into chat or put them in `NEXT_PUBLIC_*`. Normal tests and CI skip this suite unless both switches are explicitly enabled. Its worst-case runtime is bounded by the existing twenty-step/30-second-per-provider-request limits; it may incur multiple model calls. Do not enable these flags for a broad CI run unintentionally.

The test alone does not establish factual accuracy or fairness: inspect summaries against source evidence, repeat adversarial cases for the chosen model, and run the recruiter journey through the actual configured UI before declaring acceptance. Missing credentials, a skipped live suite, or an injected-model success must never be reported as real-model completion.

## Verified results and remaining limits

Latest local verification: `corepack pnpm check` passes lint, typecheck, tests and build. All 71 API regression tests passed before the additional tool-phase regression; all 15 runtime cases then passed, including that new regression. The real-model API and desktop/mobile browser journeys passed. The general browser suite previously passed 25 checks and skipped 19 opt-in/platform-specific checks. With matching localhost web/API hosts, eight live desktop workflow cases passed initially; the student case passed its corrected targeted rerun. These cover recruiting, clients/staffing terms, university workflows, student practice, session revocation and candidate assessment submission against local services.

- Implemented and verified: user-selected local provider/model; real evidence-review/selected-invitation journey; approval/effect boundaries; persistent outcomes; bounded runtime; local regression/build checks; [setup and walkthrough](nova-local.md).
- Fixed observed failure: small-model repeated preparation exhausted the step budget. The persisted prepared-proposal phase now closes model tools and requires a real final cited response. It does not fake completion or execute approvals.
- Manual review: the observed summary described duplicate retries, idempotency and one ledger entry, citing the correct evidence; it identified monitoring clarification from the rubric rationale. “Duplicate API calls” was a model paraphrase of duplicate retries, not a separate verified fact. Humans must inspect report evidence and correct overinterpretation.
- Pending beyond local acceptance: broader model/fairness/adversarial evaluation, independent security review, production provider/sandbox and operational encryption-key/retention policies. MCP remains conditionally omitted as documented above.

OAuth and the goal's other excluded features remain outside scope. No external deployment or production certification is claimed.
