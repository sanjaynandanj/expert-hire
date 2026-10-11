# Local Nova on an M4 / 16 GB Mac

The selected development setup is Ollama with `qwen3.5:4b`. This is a real local model, not mocked AI. On October 9, 2026, its API/runtime acceptance and desktop/mobile browser journeys passed against disposable fictional data. The API journey took about 28 seconds; browser journeys took about 30–34 seconds after the web server was ready. These are local measurements, not latency guarantees or production certification.

Start the local model server in its own terminal:

```sh
OLLAMA_HOST=127.0.0.1:11434 OLLAMA_NO_CLOUD=1 OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_CONTEXT_LENGTH=8192 ollama serve
```

Download the model once:

```sh
ollama pull qwen3.5:4b
```

The explicit API profile is in `ops/nova-local.env.example`. From the repository root, load it before starting the API:

```sh
source ops/nova-local.env.example
corepack pnpm --filter @northstar/api dev
```

Do not run a second API process on port 4000; stop the existing development launcher first when changing its environment. Keep the web/API browser hosts consistent, normally `http://localhost:3000` and `http://localhost:4000`.

The profile selects Chat Completions, the local endpoint, the explicit model and `NOVA_COMPATIBILITY=ollama-local`. The placeholder `NOVA_API_KEY` is ignored by Ollama; it is not authentication. The adapter uses Ollama's documented `max_tokens` and disables model thinking with `reasoning_effort=none` for a bounded text/tool workflow. It does not enable cloud requests or select cloud models. Cold model loading or long requests may exceed Nova's existing 30-second provider deadline; warm up and measure before assuming readiness.

Once ready, run the existing real-provider acceptance suite:

```sh
source ops/nova-local.env.example
NOVA_LIVE_VERIFICATION=1 NOVA_LIVE_CALLS_APPROVED=1 corepack pnpm --filter @northstar/api exec vitest run src/nova-live.integration.test.ts
```

Those two flags authorize the explicitly configured provider; with this loopback-only profile and cloud-disabled server, there are no cloud inference charges. Do not carry the flags into another provider configuration without separately approving its charges.

Only fictional test data should be used until safety/quality evaluation is complete. Keep Ollama bound to loopback: its ignored API-key placeholder must not be mistaken for protection on a public endpoint. A successful local suite still requires checking the actual UI journey and reviewing evidence-grounded summaries.

The real browser check (no API/model mocks) can be repeated with the app, API and worker running:

Nova is available from the persistent bottom-right **Nova** launcher and the full `/workspace/copilot` page. Neither starts with a role dropdown or candidate setup form. Type “Review assessments for Senior Platform Engineer.” The assistant matches authorized job titles conservatively and asks which job you mean if there is ambiguity or no match. This title matching and the clarification text are UI guidance, not model inference. Actual evidence summaries still come from the configured real model and must pass citation checks.

Evidence-only review automatically retrieves a bounded batch of up to five completed assessments with evidence, in record order rather than score order. It identifies the scope and never claims a partial batch is the full job. Assessments lacking evidence are not invented into reviews. Invitations are a separate request: type “Prepare next-round invitations,” choose the people and a later round using inline cards, then select “Preview invitations.” Nobody is preselected. The exact recipients, round, link validity and credit cost appear in the approval card before any invitation or debit occurs.

The composer stays at the bottom; Enter sends and Shift+Enter adds a line. Replies retain the current job unless a different/ambiguous job is mentioned, and fresh reports are retrieved for each model run. A same-job follow-up closes its old unexecuted proposal. History restores saved outcomes; expanding/minimizing the widget preserves the mounted conversation. Public pages show a sign-in prompt without fetching recruiter data. Model/API failure is reported honestly, without a fake summary. The full page and widget share this assistant and the same authenticated approval endpoints.

```sh
source ops/nova-local.env.example
NOVA_LIVE_VERIFICATION=1 NOVA_LIVE_CALLS_APPROVED=1 PLAYWRIGHT_BASE_URL=http://localhost:3000 NEXT_PUBLIC_API_URL=http://localhost:4000 corepack pnpm exec playwright test tests/e2e/nova-live.spec.mts --project=chromium --workers=1
```

The test creates and deletes only its disposable fictional workspace/account. It checks report links, no effects before approval, exactly one selected invitation/debit, an unselected person remaining untouched, and persisted outcomes after reload. The model ignored instruction-like candidate evidence in the observed run. Human review remains essential: valid citations and a few passing injection cases do not establish universal factual accuracy, fairness or injection resistance.

Once a proposal is prepared, Nova removes its model tool catalog and asks for the final cited review. This fixes the observed small-model repeated-preparation loop without synthesizing an AI response or weakening human approval. Unexpected further tool calls fail safely.

References: [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility), [cloud-disabled configuration](https://docs.ollama.com/faq#how-do-i-disable-ollama-cloud-features), [selected model](https://ollama.com/library/qwen3.5:4b).
