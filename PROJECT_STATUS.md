# PROJECT STATUS

Saved: 2026-09-27 (after Phases 5, 6, 7 and 8). Everything below was checked against the repository and Git state at save time.

## Git state

- Branch: **`phase-0-hardening`** (local only; no upstream configured; nothing pushed; no PR).
- Phases 5, 6, 7 and 8 are the newest work and were **not committed** when this file was saved (committing was not asked
  for): `git status` shows them as modified and untracked files on top of HEAD `4275b9d` ("Record Phase 3 and 4
  status"), which follows `5451f24` "Phase 3 and 4: safe provider foundation, and a planner that chooses for
  reasons". New this round: `packages/telemetry`, `packages/knowledge`, `docs/observability.md`, `docs/knowledge.md`, the knowledge
  route/service/store/migration/script in `apps/api`. If the tree is clean when you read this, someone committed them; check
  `git log --oneline -5`.
- Remote `origin` = `https://github.com/SaiPavan122001/AI-Trip-Planner.git`. No stashes. Nothing pushed.
- Phase 3+4: `5451f24`. Phase 2: `c32d650` (multi-agent architecture), `d86bee0` (contract and self-drive
  tests), `ab92923` (status files). Phase 1: `91b3d14`, `e5a4fd9`, `09683bb`. Phase 0: `ac56815` … `377cf81`
  plus `b5b193c`, `2302a8c`.

## Phase 0 — completed

A repository audit produced fifteen numbered fixes, each its own commit, plus two follow-ups: S14
real ESLint/CI; S1 booking API disabled and event forging closed; S2 every questionnaire answer
validated; S6 accessibility asked of everyone and enforced; S7 self-drive time zones; S12 INR only;
S8 self-drive priced as a real ₹0 fare and unknown costs never counted as zero; S5 time windows as
hard constraints; S3 LLM output untrusted; S4 modification honours pins, asks for consent, re-plans;
S11 plans scored against every option found; S9/S10 Amadeus hotel mapping; S13 atomic per-user
idempotency; S15 documentation corrected; `2302a8c` lint fix; `b5b193c` dead scripts removed and
`/health` no longer leaks DB errors. A detailed Phase 0 report was delivered in an earlier session.

## Phase 1 — completed (all committed)

- **Product rules:** budget is a guide unless `budget.firm` ("do not exceed"); plans over a guide are
  shown, flagged (`over_budget_guide`) and ranked lower; over a firm limit they are filtered/blocked;
  plans ranked on journey and stay together; comfort upgrade asks consent only when the budget is firm.
- **Storage:** optimistic locking (`version`), `pins`, `lastSearch`; additive migration
  `20260301000000_phase1_identity_runs`; `Store` = trips + runs + identity; in-memory and Prisma
  implementations pass one 34-case contract suite (also on real PostgreSQL). The original init
  migration could never apply (a pasted Prisma banner) and was fixed.
- **Identity:** anonymous users + HttpOnly cookie sessions (HMAC of token stored), emailed magic link
  via a `Mailer` interface, ownership everywhere (someone else's trip = 404), export/delete account,
  Origin check on writes, `TRUST_PROXY`, rate limits and daily search quotas, audit events,
  housekeeping. `X-User-Id` removed. Revalidation tokens blanked in all responses except the export.
- **Background planning:** lease-based queue (`planning_runs`, `FOR UPDATE SKIP LOCKED`), worker in
  the API process or separate, heartbeat/attempts/crash recovery, cancel, timeout, `AbortSignal`
  through engine and providers, `superseded` results discarded, persistent pins.
- **Web, docs, compose (separate worker), CI (Postgres integration + smoke).**

## Phase 2 — multi-agent planning architecture — implemented and verified (see caveats)

Built in the new workspace `packages/agents` (`@trip/agents`). No agent framework, no RAG, no vector
database, no embeddings, no booking or payment, no new services.

**What exists**
- **Agent contract** (`contract.ts`): model call → strict schema → deterministic sanitiser →
  structured outcome (`ok` with data + dropped items + warnings, or an error code); rule-based
  fallback when there is no model, it is slow (deadline), unavailable, or its output is unusable;
  cancellation honoured; never throws.
- **Requirements Agent** (`requirements/`): natural language → hard requirements and soft
  preferences, each with a quote of the traveller's words. Checks: quote must be in the message;
  dates re-read from the quote (only if it names a date), amounts only if the quote states them,
  counts only if the quote contains them; closed vocabularies; hard mode requirements need words that
  say so ("we like trains" excludes nothing); missing fields and conflicts computed in code. Rule-based
  fallback reads only plainly stated facts. `requirementsToAnswers` maps results onto the interview's
  own answers; `toTripInput` gives a `POST /v1/trips` body only when complete.
- **Transport / Accommodation / Activity Agents** (`guidance/`): bounded soft guidance, grounded in
  what the traveller stated; `applyGuidance` fills gaps only (never overwrites an answer, never touches
  hard requirements, priorities or budget). Modes to consult decided in code; impossible requests
  (`impossible`) reported before any model or provider call. No price/schedule/duration fields exist.
  Interests are a closed list that the engine maps to provider place types; pace sets activities/day.
- **Budget service** (`budget-service.ts`): deterministic; statuses `no_budget`, `within`,
  `over_guide`, `over_firm`, `over_firm_waived`; consistency check of the cost parts; `describeBudget`
  wording written from the assessment; "within" never hides unpriced costs.
- **Validation service** (`validation-service.ts`): independent final gate (dates, stay vs trip
  dates/nights/capacity/rooms/category, currency and provenance, cost arithmetic, budget firm and
  misreported remaining budget, itinerary overlaps, excluded modes, kept parts unchanged). Failures
  become `validation.*` blockers; plans sort last; nothing is repaired.
- **Synthesis Agent** (`synthesis/`): facts built in code (`facts.ts`, provider text cleaned via
  `safeText`); prose fact-checked (no figure not in the facts, no figures in words, no links, no
  booking/payment/guarantee claims, no recommending a blocked plan); template narrative on failure.
- **Orchestrator** (`orchestrator.ts`): fixed order (guidance agents in parallel → apply guidance →
  deterministic plan search behind a `PlanningServices` port → validation → synthesis), trace entry per
  stage, statuses `planned | no_valid_plan | no_plans | impossible`, `replan()` (re-runs agents,
  revalidates pins with the engine's `checkPins`, recomputes budget). Returns a result; never persists.
- **Integration:** `RunService` calls the orchestrator; sessions gain `statedRequirements`,
  `narrative`, `agentTrace` (no migration: JSON document); `statedRequirements` is part of the search
  fingerprint. `checkPins` moved from the API to `@trip/engine`. New endpoints:
  `POST /v1/requirements/interpret` (no session needed, changes nothing) and
  `POST /v1/trips/:id/requirements` (owner only; applies through the ordinary `answer` path; reports
  applied / rejected / unmapped / keptForPlanning / differences / conflicts; nothing applied on
  conflicts). Both rate-limited 10/min. `@trip/llm` gained `structured()`, `signal` support and
  `LlmInvalidOutputError`. Engine gained `ActivityGuidance` and `activityGuidance` on `generatePlans`.
  Web: `NarrativeCard`, `AgentTrace`, `SayItBox`. Env: `AGENT_TIMEOUT_MS`.
- **Also fixed:** the in-memory store's `latestRunForTrip` picked arbitrarily among runs created in
  the same millisecond (a latent flaky test); the itinerary "service" is the existing engine
  scheduler (`buildItinerary`), reached through the services port, not re-implemented.

## Phase 3 — real external APIs/tools and the provider architecture — implemented; nothing live-verified

Defined by the user. No RAG. Extended the existing provider interfaces (no parallel layer).

- **Outcomes:** `invalid_response` status; `statusClass()` (not available / failed / timed out / rate limited
  / no results / unusable) in a dependency-free `@trip/shared/provider-status` (used by the web page too).
  `ProviderNote`/`ProviderFailure` gained an optional `capability`; `dedupeProviderNotes` (shared, used by the
  run service) keys on provider + capability + status + message; `missingCapabilityNote(capability, ids)` words
  each capability separately (the Flights/Hotels merge is fixed).
- **Validation:** `packages/providers/src/schemas.ts` + `guard.ts` (`readResponse`, `readItems`). Amadeus
  (token, flight offers, pricing, airports, hotel list, hotel offers), OSRM, Nominatim, Google Places/Routes and
  the rail/bus contract are all read through schemas; `httpJson` throws `InvalidResponseError` /
  `NetworkError`; `toProviderFailure` classifies them. The rail/bus contract now really enforces the UTC offset
  and arrival-after-departure rules its docs promised, and validates service by service.
- **Isolation:** `ProviderPolicy` on `ProviderRegistry` (`policy`, default `IsolatingPolicy`,
  `PROVIDER_CALL_TIMEOUT_MS`, default 45000); engine `provider-calls.ts` (`sweepProviders`,
  `primaryFailure`); transport, hotels, activities and transfers use it; each transport mode is isolated.
- **Adapter fixes found on the way:** OSRM night tariff used the server clock (now the ride's zone, via a new
  `timezone` on `TransferSearchRequest`); one taxi for any party (now `ceil(party/4)` cars, `vehicles` on
  `TransferOffer`); Amadeus offer ids collided between outward and return (now include route and date);
  rail/bus ids include the day; Nominatim "nothing here" reverse answers are empty, not errors.
- **Mail/webhook:** `WebhookMailer` refuses redirects and tells timeout from unreachable; new `mailer.test.ts`.
- **Phase 2 fixes:** `parseRupees` moved to `@trip/shared` (`amounts.ts`) and made strict; used by the
  Requirements Agent and by `interpretModificationByRules` in `@trip/llm`, which had its own reader with the same
  bug. Confirmed against the old code: "a budget trip to Goa on 12 December" → ₹12, "at most 4 people" → ₹4,
  "max 3 nights" → ₹3; and in the change-request reader "keep the budget as it is but leave on 12 December" → ₹12 and
  "budget for 4 people" → ₹4 (both readers were executed against their old code). The money-clause filter in `rules.ts` now uses word boundaries. "confirm" never matched
  "firm" (already `\bfirm\b`); regression tests added. The same-millisecond run ordering fix is kept and now has
  a store-contract regression test (memory and real PostgreSQL).
- **Config/docs:** `PROVIDER_CALL_TIMEOUT_MS` in `.env.example`; `docs/providers.md` (outcome classes,
  capability notes, isolation, what is not built, fixtures, mail webhook), `SECURITY.md`, README.
- **Not built (extension points only):** retries beyond `httpJson`'s bounded transient retries, fallback between
  providers, shared rate limiting, circuit breaking, response caching, metrics/tracing.

## Phase 4 — advanced trip planning and optimisation — implemented on the existing engine

Defined by the user. No RAG. `generatePlans`, the scheduler, cost, validation, and the pin/consent/replan flow
were extended, not replaced.

- **`optimize.ts`:** `styleTargets`, `effectivePriorities` (own ranking wins; else the travel style; safety-first
  prepends `safest`), `rankTransport` (budget / comfort / balanced orderings), `chooseRoom` (fit to what was
  asked first, then price tier by archetype and style, within an accommodation ceiling), `rankStays`,
  `explainTransport` / `explainStay` (plan `choices`: what, why, what was passed over).
- **`plans.ts`:** each archetype builds a ranked set of candidates (3 journeys × 3 returns × 4 stays), tries
  combinations most preferred first, and under a firm total budget prunes by the known floor and builds at most 4
  itineraries, taking the first that fits, else the closest (marked as breaking the limit); nothing loosens a
  limit. `other.requirements` free text is listed on the plan and stated as not checked. Kept offers whose price
  quote has expired are flagged. Own-car plans state which costs were not calculated.
- **`feasibility.ts`:** `lastSearch.feasibility` = `{ status, findings[] }`; excluded journeys with reasons,
  failed vs unsearched vs empty sources, a budget below the cheapest combination found (with the figure and what to
  raise), rooms that may not sleep the group, own car for more than five. Findings reach the explanation as facts.
- **Scheduler (bugs reproduced by failing tests first):** activities started at the same moment as the journey
  to them; opening hours were checked only at the start; a visit could run through dinner; check-out was fixed at
  11:00 even for a 06:00 flight (now the earlier of the two, validated in the engine and the agents' gate);
  `late_night_arrival` looked at the journey home. Also: nearest-first visiting order from the hotel, item ids in
  time order (they were a process-wide counter), hotel occupancy judged room by room, stay budget counts every
  room.
- **Interview:** `safety.preferences` (after travel style; `safety_first`, `no_late_arrival` = no arrival 23:00–05:00,
  enforced as a filter and a validator blocker — `avoidRedEyeArrival` existed but was never enforced) and
  `other.requirements` (last). Both optional. Profile gained `special.safetyFirst` and `special.otherRequirements`.
- **Schema (additive, JSON document, no migration):** `TripPlan.choices`, `SearchSummary.feasibility`,
  `TransferOffer.vehicles`, note `capability`. Older stored trips read with defaults (tested).
- **Web:** `FeasibilityPanel`, "Why this plan" in `PlanCards`, per-capability note headings with status labels.
  Type-checked, built and linted; **not** clicked through in a browser.
- **Changed behaviour to know about:** with a firm total budget the planner now builds plans inside it when it can
  (before, the Comfort plan could be built above it and shown blocked), so one Phase 1 test was rewritten to test
  the ranking invariant directly and a new one asserts the fitting behaviour.

## Phase 5 — reliability, scalability, performance and resilience — implemented and verified in tests; nothing live-verified

Defined by the user. Built on the Phase 3 provider architecture and the Phase 4 planner, not beside them. No RAG.
Full design and the failure table: `docs/reliability.md`.

- **Layered time model.** One search deadline (`PLANNING_TIMEOUT_MS`) is divided: the orchestrator keeps back
  what the explanation needs; the engine gives journeys+things to do 45%, stays 60% of the rest, itineraries the
  remainder (each transfer lookup ≤ 10 s); a provider call gets min(its ceiling, its stage's time); an HTTP attempt
  gets min(its timeout, what the call has left). `withBudget`/`AsyncLocalStorage` scope
  (`packages/providers/src/call-scope.ts`) carries cancellation, deadline and a request allowance to everything a
  call starts, including adapters that never passed a `signal` on (the transfer search and the place lookup did not,
  so cancelling a search left their requests running). A hung provider now costs its own results only.
- **Retries** (`httpJson`): transient failures only (network, timeout, 408/500/502/503/504), safe requests only
  (GET by default), a count, jittered exponential delay with a ceiling, the call's deadline, a per-host retry budget.
  A 429 and other 4xx are never retried; sleeping is abortable; redirects only to the same origin.
- **Circuit breaker** in `ResilientPolicy` (the registry's default policy): per provider and capability, states
  CLOSED / OPEN / HALF_OPEN, configurable threshold and recovery time, `Retry-After` honoured, planner-caused
  ("local") failures not counted, a skipped call keeps the last real failure in its message. The language model has
  its own breaker in `TripLlm`.
- **Fallback** (`fallback.ts`): routing (Google, then OSRM) and geocoders; the answer names the provider that
  answered and what failed first; all-fail lists every failure; cancellation does not fall through. (Found on the
  way: the self-drive answer had been dropping the routing provider's warnings; it now carries them and says which
  provider measured the drive.)
- **Caching** (`cache.ts`): places 24 h, routes 6 h, things to do 6 h; never prices or anything about a person;
  keys hold every parameter; values are schema-checked on read; bounded; shared through Redis when configured;
  a failing store is a miss. In-flight duplicates share one call, except a follower never inherits a cancelled
  leader's failure (a test found that bug).
- **Rate limiting** (`apps/api/src/security/rate-limit.ts`, `infra/counters.ts`): replaced `@fastify/rate-limit`
  (still installed, no longer used) with a limiter that counts the person **and the address**, named per-route
  policies, `RateLimit-*`/`Retry-After`, Redis counters (`ioredis`, new dependency) with a per-process fallback
  rather than fail-open. Fixes the anonymous-cookie loophole (see Phase 6). A test found that two rules of one policy
  on the same address shared a counter; fixed.
- **Idempotency** (`security/idempotency.ts`) on create, plan, modify, consent, requirements, cancel and magic
  link, using the existing table and store methods; 5 behaviours tested including concurrent duplicates.
- **Overload**: bounded queue (`503 busy` + `Retry-After`), per-user active-run cap, stale queued runs dropped,
  a ceiling on provider requests per search, 64 KB body limit, per-address anonymous search allowance.
- **Database/state**: `deleteSession` no longer reports success when the database failed; a modify whose search
  cannot be queued no longer leaves the trip "searching" with no run (checked before saving, restored after);
  `GET /v1/me` counts rows instead of reading fifty trips; `GET /v1/trips` returns summaries. New store methods
  (`countQueuedRuns`, `countActiveRunsForOwner`, `expireStaleQueued`, `countSessions`) pass the shared
  contract on memory **and real PostgreSQL**. No index was added: every query pattern was checked against the
  existing indexes and none was missing.
- **Performance**: measured first (`packages/engine/scripts/measure-plan.ts`, fake providers at 150 ms/call):
  13 calls / 1853 ms before, 9 calls / 844 ms after (−54%) by building the three plans together and sharing
  identical transfer lookups within a search. Amadeus token requests are single-flighted.

## Phase 6 — security, abuse protection and data protection — implemented and verified in tests; not penetration tested

Defined by the user. Threat model first: `docs/threat-model.md`. Audit by the authors, with tests for each fix.

**Audit found nothing wrong with** ownership (IDOR/BOLA: every trip route walked as a stranger and as no one,
plus forged cookies and headers), SQL injection (Prisma; two raw queries use bound parameters), command injection
(nothing spawns), XSS in the web app (no unsafe rendering), booking (501 for everyone), and the git history (no
credential patterns; only the documented local dev database login).

**Found and fixed:** the anonymous-cookie loophole (limits counted the person only; now person **and** address, plus a
per-address daily cap on anonymous searches and tight per-address counting of first trips); `httpJson` followed
redirects (SSRF): now same-origin only, and a general SSRF guard exists; the prompt data block could be closed from
inside the text (`</tag>` survived JSON escaping) and hidden Unicode was passed through: fixed in one helper
(`@trip/shared` `prompt-safety`) used by the agents and the change-request path; an activity name offered by a model
did not have to be one the traveller wrote; the LLM adapter followed redirects with the key; no CSP/HSTS/Permissions-
Policy on the web app; API answers were cacheable; the 404 echoed the request; framework error messages quoted input;
log redaction covered only one level (top-level `email`/`token` slipped through) and the request logger wrote
headers/cookies/addresses; `/v1/providers` named environment variables (also in per-capability messages) and
`/v1/providers/health` made billed calls for anyone; sessions never expired while used; no "sign out everywhere";
no lockout for guessing sign-in links; unbounded strings (place names, answers, plan ids); the default
`text/plain` body parser allowed cross-site simple requests; configuration URLs were not validated.

- **Auth:** absolute session lifetime (`SESSION_MAX_DAYS`), `POST /v1/auth/logout-all`, lockout after 8 refused
  links in 15 minutes (counted per address; checked before the store is touched), per-recipient/person/address/day
  limits on sign-in emails.
- **CSRF:** only JSON bodies are read; `Origin` allow-list; `Sec-Fetch-Site: cross-site` without `Origin` refused.
- **SSRF:** `packages/providers/src/ssrf.ts` (every address spelling; DNS re-check for names), redirect rule, start-up
  validation of base URLs (scheme, credentials, https in production), body-size cap on provider responses.
- **Data:** an address is only ever a keyed hash (counters, Redis keys, logs); logs hold method, path, id, status and
  security events; hidden characters stripped from stored free text; email never copied into trips, runs or audit.
- **Web:** CSP and the other headers in `next.config.mjs`; `safeHttpLink`; the trips list uses the summary shape;
  the sources page copes with hidden setting names. Static tests (`web-safety.test.ts`) keep unsafe rendering out.
- **Deployment information:** provider details and live probe off in production (`EXPOSE_PROVIDER_*`).

## Phase 7 — observability, metrics, tracing and operations — implemented and verified in tests; no collector or Prometheus used

Defined by the user (with Phase 8). Design: `docs/observability.md`. **One system**: the OpenTelemetry *API* in the libraries (a
no-op until `setupTracing` installs the SDK in the API or worker), an own metrics registry (Prometheus text), one error vocabulary.

- **New package `packages/telemetry`** (`context`, `errors`, `metrics`, `instruments`, `tracing`, `sdk`; 42 tests): `withSpan`,
  `startManualSpan`, `withCorrelation`, `safeAttributes` (allow-listed names, length cap), `MetricsRegistry` with closed labels and a
  series cap (`telemetry_series_dropped_total`), `ErrorCategory` + `categoryOfError/Http/ProviderStatus`, `describeError`
  (class, category, frames; the message only when `LOG_ERROR_MESSAGES`).
- **Instrumented, not redesigned:** provider policy/`httpJson`/fallback/cache (spans, calls, failures by class, latency, retries,
  fallbacks, circuit transitions; 22 tests), `TripLlm` (span and metrics, tokens, cost only from `LLM_PRICE_*`; 9 tests), agents and
  orchestrator stages, `plans.ts` stages, run service (`planning.run` span, duration, queue wait, outcome), worker, and every store
  operation through a proxy (`instrument-store.ts`: operation name only, never an argument).
- **Correlation across the queue:** the request's W3C `traceparent` and request id are stored in the run row (`params.trace`); the worker
  (in any process) continues the trace. An inbound `traceparent` from a caller is ignored.
- **API:** request span, `X-Request-Id`, `X-Error-Category`; `/live` (touches nothing; the Docker health check), `/ready` (store, queue,
  geocoder configured; not an optional provider), token-protected `/metrics` and `/ops/status` (404 without `OPS_TOKEN`, constant-time
  compare, lockout); worker can serve `/live` and `/metrics` on `WORKER_METRICS_PORT`.
- **Tests:** 110 new (telemetry 42, providers 22, llm 9, api `observability.test.ts` 37), including planted secrets searched for in every
  span, metric and log line, correlation through the queue, retry/fallback/circuit/planning-duration/queue-wait metrics, error
  classification, readiness, and label-cardinality. **Mutation checks run this session:** request span outside the correlation
  scope, run not storing its `traceparent`, span attribute filter removed → the matching tests fail (killed).
- **Not verified:** no OTLP collector, Prometheus, Grafana or alert manager was used (spans go to an in-memory exporter in tests;
  alerts are documented PromQL with unmeasured thresholds); the worker's own `/metrics` server was tested, not run in a container.

## Phase 8 — knowledge (RAG), evaluation, regression and groundedness — implemented and verified offline; no real embedder or model used

Defined by the user (with Phase 7). Design, numbers and limits: `docs/knowledge.md`. RAG is used **only** for written policies, rules and guides;
live provider facts, calculations and validation keep their owners and **planning does not call it**.

- **New package `packages/knowledge` (`@trip/knowledge`, 156 tests):** document schema and authority by source type; `scan.ts` (instruction-like
  text, role markers, tag boundaries, exfiltration, hidden characters, look-alike letters, base64/hex/rot13, secrets, personal data);
  `validate.ts` (strict schema, source-link check, never fetched); `chunker.ts`; `embedder.ts` (`HashingEmbedder` offline and lexical;
  `OpenAiEmbedder` unverified live; named vector spaces); `store.ts` (`KnowledgeStore`, in-memory store, shared exact `rankChunks`);
  `ingest.ts` (versions, dates, duplicates, quarantine, atomic swap); `retrieve.ts` (filters, weighted confidence gate, staleness,
  re-screen, lexical rerank, disagreement); `verify.ts`; `answer.ts` (grounded answers, citations, fixed insufficient sentence);
  `env.ts`; `testing/` (store contract, scripted models); `eval/` (corpus, datasets, harness, groundedness, hallucination, injection,
  regression report, A/B, latency, CLI, live script).
- **API and storage:** additive migration `20260401000000_phase8_knowledge` (2 tables + a partial unique index), `PrismaKnowledgeStore`
  (`apps/api/src/repository/knowledge-prisma.ts`), `KnowledgeService`, `POST /v1/knowledge/ask` (off unless `KNOWLEDGE_ENABLED`; session; strict
  body; owner-only `tripId`; `knowledge.ask` limits; fixed 503), `/ops/status` knowledge block, `apps/api/scripts/ingest-knowledge.mjs`
  (`npm run ingest:knowledge`). Build order: `knowledge` after `llm`; Dockerfile, CI and root build updated.
- **Tests:** 156 in the package, 29 API (`knowledge.test.ts`), 10 against PostgreSQL 16 (store contract + a parity test asking all 43
  questions of both stores, requiring identical answers), 6 new smoke checks (built ingestion script → PostgreSQL → HTTP). **19 mutation
  checks** (verification removed, off-topic check, conflict handling, staleness, retrieval screen, authority filter, relevance threshold,
  coverage gate, space isolation, namespace isolation, version rule, duplicate rule, quarantine, screen rules, link check, prompt escaping,
  session requirement, trip ownership, rate limit): all failed the tests, none survived.
- **Baseline results** (offline, deterministic; committed in `packages/knowledge/eval/baseline.json`): retrieval Recall@3 0.917, Precision@3 0.361,
  MRR 0.938, hit rate 0.917; answers (quoting path) pass 0.837 (holdout 0.733); groundedness accuracy 1.0 with 0 false accepts on 23 pairs but
  **3 of 3 "hard" recombinations accepted**; hallucination 0 leaks in 70 runs; injection 21 of 21 attacks blocked by the pipeline, **19 of 21 by
  the verifier alone**, and the 1 attack written to pass every layer **reaches the answer**. Latency: knowledge pipeline ~2.5 ms mean (offline stand-ins)
  against ~800 ms for a synthetic planning search; prompt ~524 tokens on average.
- **Not verified:** no real embedder or language model has run through it (the live evaluation script exists and has never been run);
  the corpus is 15 fictional documents and 43 questions (one case moves a rate by 2 points, and the authors wrote both the pipeline and the
  dataset); the scanner is a tripwire; the verifier is lexical; chunk size, k and per-document caps cannot be told apart on this corpus;
  exact search has been run on 27 chunks; the evaluation numbers measure the pipeline with a lexical embedder, not semantic retrieval.

## Currently being worked on

Nothing is in progress. Phases 3–8 are implemented and verified as listed below. **Phases 9 and later are not defined by the
user; do not invent or start them.** Nothing is committed (see "Git state").

## Tests and checks completed (all executed after the final code change)

| Check | Result |
|---|---|
| `npm run build` (all workspaces incl. web) | exit 0 |
| `npm run lint` | exit 0; 0 errors; 1 pre-existing warning (`no-page-custom-font`, `apps/web/app/layout.tsx`) |
| `npm run typecheck` | exit 0 |
| `npm test` | agents 140, engine 273, knowledge 156, llm 71, providers 315, shared 89, telemetry 42, api 539 = **1625 passed** (Phase 5/6 baseline 1330) |
| `npm run test:integration` (embedded PostgreSQL 16) | 58 passed (was 48): +10 for the knowledge store (contract, and a parity test: all 43 evaluation questions answered identically by the PostgreSQL and in-memory stores) |
| `node apps/api/scripts/smoke.mjs` and `… --split` | both passed, **25 checks each** (was 19; +6 knowledge steps through the built ingestion script, PostgreSQL and HTTP) |
| `npm run eval -w @trip/knowledge` (built) | "Identical to the baseline." exit 0 (30 metrics, fingerprint and digest equal); also run as tests |
| Mutation checks (Phase 8: 19, Phase 7: 3 this session) | every mutation killed by the tests, none survived (list in the Phase 7 and 8 sections) |
| Credential-pattern scan (the repository's own patterns) over tracked **and untracked** files, 357 files | 0 hits, after four Phase 8 test fixtures that would have failed `leakage.test.ts` once committed were rebuilt at run time |
| Invisible-character scan of every changed and new file | none, apart from two intentional zero-width joiners in a Phase 6 test |
| New dependencies this round | OpenTelemetry API/SDK packages (Phase 7, in `packages/telemetry`); `@trip/knowledge` is a workspace, no external package added; no major upgrade |
| Secret scan (tracked files by a test; all 25 commits of history by pattern) | nothing found apart from the documented local dev database login |
| Mutation checks (change the code, see the tests fail) | ownership check removed → 13 failures; address rule removed → cookie-rotation test fails; `Sec-Fetch-Site` rule removed → 3; `.strict()` removed → 1; retry-429 / retry budget / retry deadline / redirect rule → the matching tests fail |

New tests, by what they hold to: **providers** — every adapter through success / empty / refused / rate limited /
5xx / hang / network failure / not JSON / wrong shape / one bad row, from fixtures, no network; the isolating
policy; capability-specific notes; OSRM tariff clock and party size; offer ids. **engine** — domestic vs
international mode selection; provider throw / hang / limit / empty / unusable / partial failure; itinerary
overlaps, travel legs, opening hours for the whole visit, meals, early check-out; style, room, budget-fit,
infeasible-budget, safety, feasibility, group, replanning-with-kept-parts, cancellation, determinism, domestic
mode choice. **agents/llm** — the date-as-money and "confirm" regressions, feasibility in the explanation, a hard
limit surviving a re-plan. **api** — a crashing provider no longer fails the run, a crash in the search itself
still does (detail kept out of the response), the mail webhook.

All of Phase 2's boundary tests still pass: invalid/garbage/obedient/unavailable model output for every agent,
prompt-injected traveller text and provider-supplied names, a hostile model producing byte-identical totals,
impossible requests making no provider call, conflicting requirements applying nothing, pins preserved or released
with a reason, agents re-run on re-plan.

## Known issues, gaps and blockers

- **No real language model has run through the agents.** Everything model-shaped was tested with
  scripted fakes and mocked HTTP. How often a good real answer is dropped for want of a quote, and how
  a real model behaves against the checks, is unmeasured. Anthropic's SDK `signal` option and the new
  `LlmInvalidOutputError` paths in `anthropic.ts` are unexercised against the real service.
- **No external service has been called live** (none of Nominatim, OSRM, Amadeus, Google Places/Routes, a rail/bus
  endpoint, a real mail service), because no credentials are ever requested. Every adapter is tested against
  **hand-written fixtures, not recordings** (`packages/providers/src/__tests__/fixtures/README.md`), so what is
  proven is the mapping of the documented shape and the safe failure of everything else. Unverified specifically:
  Amadeus enum values (cancellation policy, board type) and response fields, **whether Amadeus's hotel `price.total`
  is for all requested rooms or one** (the code multiplies by rooms), the Places (New) type names the interest
  mapping uses, Nominatim's real rate-limit behaviour, and the webhook contract with any real mail service.
- **Not run:** Docker (not installed), so compose and the Dockerfiles (now including the agents
  package) are checked by inspection only; the CI workflow has not run; the web UI (including the new
  boxes) was built, typechecked and linted but not clicked through in a browser.
- The rule-based fallbacks are deliberately narrow (plainly stated facts only); a real requirement
  whose quote lacks the words that say it is required is dropped (reported via `droppedCount` /
  `rejected`). Later messages do not withdraw earlier requirements of kinds they do not mention.
- Unmapped requirements (latest arrival, earliest departure, max stops, free cancellation) are
  understood but have no interview question yet; they are reported, not applied.
- Accommodation amenities other than breakfast are noted but nothing scores or filters on them; rooms are chosen
  on breakfast, room type and cancellation only.
- **Phase 3/4 limits:** local legs between the hotel and activities are straight-line estimates (only terminal
  transfers are routed); no activities are planned on the arrival or departure day; visit lengths are assumed where
  unpublished; the budget-fit search looks at 3 journeys × 3 returns × 4 stays and builds at most 4 itineraries per
  plan, so it is not a global optimum; the known-cost floor ignores food and local travel until the itinerary is
  built; "safety" is only what timing and published reviews can show (no destination data, by design); free-text
  "anything else" is never interpreted; a drive with no vehicle profile ranks as ₹0 (the user's rule) with the gap
  stated; a 4-seat car per taxi, and more than five people in one own car only warns.
- **Phase 5/6 were built and tested only against stand-ins.** Redis (counters, cache) against an in-memory fake that
  implements the commands used; nothing against a real Redis, live provider, Docker, CI or a managed PostgreSQL. The
  stage shares, breaker thresholds, retry budget, cache lifetimes, queue and per-user limits are reasoned defaults, each a
  setting, not tuned on real traffic. While Redis is away the limits are per process (up to N× with N instances).
- **Phase 7/8 were built and tested without external services.** No OTLP collector, Prometheus, Grafana or alerting was used; no real
  embedder or language model has run through the knowledge layer (the `--live` evaluation exists and has never been run); the
  `OpenAiEmbedder` is tested with a stubbed `fetch`. The knowledge evaluation is on 15 fictional documents and 43 questions written by the
  same authors as the pipeline (see `docs/knowledge.md` section 13 for the limits: a lexical verifier that accepts recombinations, a
  scanner that is a tripwire, an attack written to pass every layer that reaches the answer, chunk-size settings the corpus cannot tell
  apart, exact search measured on 27 chunks). There is no web UI for knowledge answers.
- **Not built:** per-provider daily quota accounting; a nonce-based CSP for the web app (Next's
  inline scripts need `'unsafe-inline'`); the web client does not send `Idempotency-Key` yet; automatic expiry of a
  signed-in person's trips (a product decision, see `DECISIONS.md`); encryption of traveller documents (none are stored);
  a second sign-in factor; a session list.
- **The Phase 6 audit was by the authors.** It is not a penetration test. See `SECURITY.md` and `docs/threat-model.md`.
- **`@fastify/rate-limit` is still in `apps/api/package.json`** but no longer used (replaced by the shared limiter).
  Removing it is a lockfile change left for the user to approve.
- Validation does not re-check accessibility (the engine enforces it) or that items lie inside the trip
  window.
- **`npm audit` fails at baseline**; the fix needs Next 16 / Vitest 5 majors, which the user forbade.
- **Latent:** fixtures with 2026-11-10 dates will hit `departure_in_past` after that date; the agents'
  tests use 2030 dates and a fixed `TODAY`.
- **Documented security limits** (`SECURITY.md`): a botnet or an IPv6 allocation larger than one /64 defeats
  address counting (put a CDN/WAF in front); per-process counters while Redis is away; sign-in is an emailed link only;
  pre-accounts trips are unreachable.
- **Observed, not investigated (Phase 1):** a self-drive-only plan with no hotel provider shows a ₹0
  counted total with the unpriced costs listed as not included. (The Flights/Hotels note merge was fixed in
  Phase 3.)
- The user asked that the old npm cache on C: **not** be deleted; it was not. C: had 6.7 GB free at the start of
  Phase 5/6 work and 5.8 GB at the end; the difference was not traced to this project (everything ran with the
  `.devcache` environment; one empty scratch file that a command created under C:'s temp folder by mistake was removed).
- Booking remains disabled; migration drift (schema vs SQL) is not checked automatically. Phase 5/6 added **no
  migration** (the queue/idempotency/session tables already had what was needed).

## Exact next step when a new session starts

1. Read `CLAUDE.md`, this file, `PHASE_PLAN.md`, `DECISIONS.md` (and `SECURITY.md`, `README.md`, `docs/` when the
   work touches them). Do not ask the user to paste them.
2. `source "/h/Projects/Mutli Agent AI Trip Planner/.devcache/env.sh"`, then `git status` and
   `git log --oneline -5`; confirm branch `phase-0-hardening` and that `5451f24` (Phase 3+4) is in the history. Phases 5–8 may still be
   uncommitted (see "Git state"). Check C: free space (5.4 GB free at the end of Phase 8, 5.8 GB at the end of Phase 6; the difference was
   not traced to this project: no project-named file was found on C:).
3. If the tree is not clean, find out why before touching anything.
4. **Do not start any new scope on your own** (Phases 9 and later are not defined). Tell the user Phases 3–8 are complete with
   the caveats above and ask what they want next. The
   most useful single next actions, if the user has no other priority, are (a) run the adapters against the real
   services, and Redis, with the user's own credentials placed in the environment by the user (never ask for them in
   chat), record real responses over the hand-written fixtures and see which schemas and which defaults (stage shares,
   breaker thresholds, cache lifetimes) need to change, (b) run the agents against a real language model and measure
   how the checks treat real output, **including the knowledge layer: run `npm run eval -w @trip/knowledge -- --live` with a real embedder and
   model and compare with the offline baseline**, (c) an independent security review, since Phase 6 was an audit by the authors, and (d) stand up an OTLP
   collector and Prometheus and check the traces, metrics and alerts in `docs/observability.md` against a real run.
   The decisions waiting for the user are in `DECISIONS.md` under "Open decisions".
5. Whatever is done next: run lint, typecheck, build and tests (and `test:integration` if storage or the API
   changed, and both smoke topologies if the request path changed), never claim a pass that was not executed, and
   do not push.
