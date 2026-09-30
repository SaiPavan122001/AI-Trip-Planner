# CLAUDE.md — read this first in every session

Wayfare (AI Trip Planner): a TypeScript monorepo, India-focused, INR only. Read, in this order:
`CLAUDE.md` (this file) → `PROJECT_STATUS.md` (where things stand) → `PHASE_PLAN.md` →
`DECISIONS.md`. Then check `git status` and `git log --oneline -5` before doing anything.

## Hard environment rules (from the user; absolute)

- The project is on a USB drive: `H:\Projects\Mutli Agent AI Trip Planner\AI-Trip-Planner`
  (note the spelling "Mutli"). C: is nearly full (345 MB free at the end of Phase 1; 2.5 GB after the user freed space during Phase 2).
- **Nothing project-related may be written to C:** — no node_modules, npm cache, TEMP/TMP output,
  databases, logs, builds, virtualenvs, or global installs. Before installing anything, work out
  where it will be written; if it cannot stay on H:, stop and ask.
- Before every npm/node command in a shell: `source "/h/Projects/Mutli Agent AI Trip Planner/.devcache/env.sh"`
  (PowerShell: `.devcache\env.ps1`). It points the npm cache, TEMP/TMP and APPDATA at
  `H:\...\.devcache` (a sibling of the repo, not versioned) and disables telemetry.
- Do not reinstall or relocate system software (Node, Git, Docker, VS Code, Claude Code).
- If C: free space is low or shrinking, tell the user; do not start heavy work.

## Working rules the user set

- **Do not push. Do not open a PR.** Work stays on the local branch.
- Booking is **disabled** and stays so. Never ask for API keys or credentials; use env
  placeholders. Never ask the user to paste repository files: read them yourself, and read the
  repository before planning.
- **Agents (changed in Phase 2, by the user):** the multi-agent architecture in `packages/agents`
  is in scope and is the product's design. Earlier sessions were told "no agents"; that was
  superseded by the user's Phase 2 instruction. Still no agent *frameworks* (LangChain and the
  like), no single "master" planner agent. RAG was ruled out until Phase 8; **Phase 8 (user-defined) added it, in `packages/knowledge` only**: one
  vector store (PostgreSQL, behind `KnowledgeStore`), written policies/rules/guides only, never live provider facts, never used by
  planning. No second vector database, no RAG framework.
- **Phases (defined by the user):** 3 = real external APIs/tools and the provider architecture,
  4 = advanced trip planning and optimisation, 5 = reliability/scalability/performance/resilience and
  6 = security/abuse/data protection, 7 = observability/metrics/tracing/operations and 8 = RAG + AI evaluation/regression/
  groundedness are **done** (see `PHASE_PLAN.md`). Phases 9 and later are not defined: do not invent them or start any
  new scope unprompted.
- **Agents are untrusted.** LLMs/agents understand, interpret and explain; deterministic code owns
  prices, totals, dates, durations, constraints, validation, ranking, state changes, persistence and
  authorisation. Agent output is checked before use, never written to a store by an agent, and
  never allowed to bypass validation, consent, ownership or the budget rules. External text
  (traveller, provider, destination) reaches a model only as delimited data, never as instructions.
- Never delete the old npm cache on C: (the user asked for it to be left alone).
- No destructive DB commands. Do not weaken tests, lint or TypeScript. Never claim a check passed
  unless it was executed.
- Do not upgrade major dependencies (Next.js, Vitest, …).
- Ask the user only if a decision (1) changes an explicit product requirement, (2) has materially
  different interpretations, (3) needs an external credential/service that is unavailable, or
  (4) blocks safe progress. Otherwise decide, and record important decisions in `DECISIONS.md`.
- Commit messages end with the attribution line given by the harness
  (`Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` was used so far).

## Product principles (fixed by the user)

India-focused, INR only · self-drive fare is ₹0 with fuel/wear kept separate · friendly and flexible ·
users can pin components; invalid pins (after date/party changes) are identified and the user is told ·
explain plan-affecting changes and get consent where required · date changes re-plan affected parts ·
budget is a guide by default, "do not exceed ₹X" is a hard limit · hotel suitability counts in plan
ranking · local development with Docker where needed, architecture ready for production without
production-specific assumptions.

## Layout

npm workspaces. `packages/shared` (Zod domain model, INR money, provider result/status/notes, the
rupee-amount reader, `resilience.ts`: deadlines/backoff/circuit breaker/TTL cache, `prompt-safety.ts`) →
`packages/telemetry` (Phase 7: correlation, error taxonomy, metrics registry, tracing; the libraries use the OTel *API* only) →
`packages/providers` (vendor adapters, `httpJson`, response schemas, `ResilientPolicy`, call scope, fallback,
cache, SSRF guard) → `packages/llm` (narrow router; output untrusted) → `packages/knowledge` (Phase 8: curated-index
answers with citations, the vector store interface, the evaluation harness; nothing in the planner depends on it) →
`packages/engine`
(deterministic planner: `plans.ts` orchestrates, `optimize.ts` chooses, `feasibility.ts` reports,
`provider-calls.ts` asks providers safely) → `packages/agents` (planning agents, budget and validation services,
orchestrator; Phase 2) → `apps/api` (Fastify 5, Prisma 5.22, Zod) and `apps/web` (Next 15.5,
React 18, Tailwind 3). Tests: Vitest 2.1. Lint: ESLint 10 flat config at the root. Node ≥ 22.
Docs: `README.md`, `docs/api.md`, `docs/architecture.md`, `docs/providers.md`, `docs/reliability.md`,
`docs/threat-model.md`, `docs/observability.md`, `docs/knowledge.md`, `docs/booking.md`, `SECURITY.md`, `CONTRIBUTING.md`.

## Commands (after sourcing env.sh, from the repo root)

```
npm run lint          npm run typecheck        npm run build       npm test
npm run test:integration   # real embedded PostgreSQL 16 (no Docker); needs a built @trip/shared etc.
npm run smoke              # built API + worker end to end (run `npm run build` first)
# separate worker process (this exact form was run and passed): from apps/api,
#   node scripts/smoke.mjs --split
npm run dev / dev:api / dev:web / dev:worker
npm run build && npm run eval -w @trip/knowledge     # Phase 8 evaluation vs the committed baseline (offline; exit 1 on a
                                                     # regression or a stale baseline). `-- --write-baseline` after a REVIEWED change,
                                                     # `-- --ab`, `-- --latency`; `-- --live` is opt-in and has never been run
npm run ingest:knowledge -w @trip/api -- ./docs.json  # operator script: curated documents into the knowledge index
```

Build order matters: packages must be built (`npm run build`) before the API/web typecheck or tests
see their changes.

## Conventions worth knowing

- **Resilience (Phase 5), `docs/reliability.md`:** every provider call goes through `registry.policy`
  (`ResilientPolicy`: time budget, circuit breaker per provider+capability, isolation); retries are in `httpJson`
  (GET only, never 429); time is divided search → stage → call → attempt with `withBudget` (an `AsyncLocalStorage`
  scope carries cancellation, deadline and a request allowance, so adapters need not forward a `signal`); failures the
  planner caused are `local` and never count against a provider; only places, routes and things to do are cached (never
  prices or anything about a person). Limits count the **person and the address** (`security/rate-limit.ts`; counters in
  Redis if `REDIS_URL`, else per process; never fail open). `Idempotency-Key` is supported on the mutating routes.
  A search is refused *before* it is queued (`503 busy`, per-user and per-address caps).
- **Security (Phase 6), `SECURITY.md`, `docs/threat-model.md`:** model input goes through `promptData` (escapes `<>&`,
  strips hidden characters); the model has no tools and the owner is checked before it is asked; only JSON bodies are
  read; route bodies are strict; every string has a maximum; an address is only ever a keyed hash; logs hold method,
  path, id, status and security events, nothing a caller wrote; `EXPOSE_PROVIDER_*` are off in production; redirects are
  followed only to the same origin. When adding a route, give it a `config: { limit: … }`, a strict body, and an
  ownership check through `owned()`; add it to the walk in `authorization.test.ts`.
- **Observability (Phase 7), `docs/observability.md`:** one logger (`createLogger`, Phase 6 redaction), one error vocabulary
  (`ErrorCategory`: log `errorCategory`, metric `category`, span `error.category`, header `X-Error-Category`), correlation by
  `withCorrelation` (a run row carries the request's `traceparent` so the worker continues the trace). Wrap new work in
  `withSpan`/`observed`, count it in `metrics` (`packages/telemetry/src/instruments.ts`) with **closed labels only: never an id,
  a user, a trip, a prompt or anything a traveller wrote**. Never put an exception message or a store argument on a span. Add new
  telemetry to the leakage tests in `observability.test.ts`. `/live` touches nothing; `/ready` does not depend on an optional
  provider; `/metrics` and `/ops/status` are 404 without `OPS_TOKEN`.
- **Knowledge (Phase 8), `docs/knowledge.md`:** retrieval is for *written* knowledge only. Retrieved text is DATA (`promptData`),
  a model's claims must cite retrieved chunks and are verified in code (`verify.ts`), and what is shown is verified text or
  exactly `Insufficient verified information.`. The index holds nothing per traveller (no owner/user/trip/email field), a
  request cannot name a namespace, vectors are only compared within one embedding space, and ingestion is an operator script
  (never an endpoint; a document is screened, versioned, de-duplicated; an older version never replaces a newer one). Both
  knowledge stores must pass `@trip/knowledge/testing`'s `describeKnowledgeStore`. **Changing the chunker, retrieval settings, the
  system prompt, the embedder, the screen or the verifier changes the evaluation fingerprint: the regression test fails until you
  review the numbers and re-record the baseline.** The evaluation corpus is fictional; scripted models are stand-ins, not
  evidence about real models. No real embedder or model has been run.

- Money is integer minor units; only INR (`SUPPORTED_CURRENCY`). `@trip/shared/currency` is a
  dependency-free subpath for the browser.
- Provider results are a tagged union with provenance; never fabricate data; unknown price ≠ ₹0.
  A provider outcome is one of six classes (`statusClass`): not available, failed, timed out, rate
  limited, no results, unusable response (`invalid_response`); notes carry the `capability` they are
  about and are never merged across capabilities.
- Every adapter reads a response through a Zod schema (`packages/providers/src/schemas.ts`) before
  mapping it; every provider call goes through `registry.policy`; the engine asks providers with
  `sweepProviders`. Provider fixtures under `packages/providers/src/__tests__/fixtures` are
  hand-written from vendor docs, **not recordings**; tests stub `fetch` and fail on any unlisted URL.
- Choosing among offers is `optimize.ts`, deterministic and explained (`plan.choices`); whether a trip
  can be done as asked is `feasibility.ts` (`lastSearch.feasibility`). A firm budget is kept when a
  combination fits it; the planner never loosens a limit itself.
- The LLM only classifies modification requests; its output is sanitised per field and the text shown
  to travellers is written from the validated request, never by the model.
- The API talks to the `Store` interface (trips + runs + identity); `InMemoryRepository` and
  `PrismaRepository` must both pass `apps/api/src/__tests__/support/store-contract.ts`.
- Schema changes: add a new additive Prisma migration; never edit a released one. (The init migration
  was corrected once, in Phase 1, because it could never have applied.)
- The agent contract (`packages/agents/src/contract.ts`): model call → strict schema → deterministic
  sanitiser → structured outcome (`ok` / error code); a rule-based fallback when there is no model
  or its output is unusable. Requirements need a real quote from the traveller's words; guidance
  fills gaps only; narratives are fact-checked and replaced by a template on failure.
- Match surrounding code style and comment density.

## Observed tooling quirks

- In the Bash tool, large heredocs containing quotes or `${…}` sometimes fail with "unexpected EOF".
  Use the Write/Edit tools for files, or write a small script file and run it with node.
- **Backslashes in Bash heredocs and `sed`/`node -e` strings get halved or corrupted** (a `\b` regex
  became a backspace character; `sed 's/\`/`/g'` prefixed every line with a backtick). Write files
  and edit scripts with the Write/Edit tools, run scripts from files, and avoid `sed` with
  backslashes. `.devcache/tmp/fix-bs.cjs` repairs backspace characters in the agents package.
- Paths contain spaces: quote them (an unquoted `$L/…` log path failed once).
- The repo stores LF (`.gitattributes`). In Phase 3/4 the working tree was normalised to LF, but a
  file written by another tool can come back CRLF; `git diff --stat` (not `git status`, whose entries
  can be stale after a rewrite) shows what really changed.
- Bash tool: backticks and `${…}` inside `node -e "…"` strings are executed or mangled by the shell.
  Put edit scripts in a file with the Write tool (`.devcache/tmp/*.cjs`) and run them; Edit works
  directly on LF files.
- A script whose text contains `\n`, a backslash regex or a quote-heavy template, sent through a Bash heredoc, is
  mangled (halved backslashes, "unexpected EOF"): write the script (or the text to splice in) with the Write tool and run
  it from the file, or use Edit directly. A `\uXXXX` range typed into a written TypeScript regex once came out as raw
  invisible characters; build such patterns from `String.fromCharCode` and scan changed files for invisible characters.
- **Unicode escape sequences in a tool's text (a backslash, a `u`, four hex digits) can arrive in the file as the raw
  character**: a regex written that way in a Bash heredoc, and a sentence about it written through the Edit tool, both
  left invisible characters in files. Write the Write tool's content with the escape doubled, or build the characters
  from code points at run time (`prompt-safety.ts` does the latter), and scan changed files for invisible characters
  before finishing. Never use `/tmp` in a command: Git Bash maps it to C:.
- The API package's `tsc` build also compiles its tests, so a type error in a test fails `npm run build`.
- Measure before optimising: `npx tsx packages/engine/scripts/measure-plan.ts` (fake providers, 150 ms per call).

## When a new session starts

Follow the "Exact next step" section at the bottom of `PROJECT_STATUS.md`.
