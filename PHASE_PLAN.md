# PHASE PLAN

Saved: 2026-09-27 (after Phases 5, 6, 7 and 8). Status of each phase as of the Git history on branch `phase-0-hardening`.

## Phase 0 — Hardening — DONE

Fix what the repository audit found; keep the product to planning/search/recommendation; no booking.
Fifteen numbered fixes (S1–S15) plus two follow-ups, each a commit (see `PROJECT_STATUS.md`).
Dependencies installed on H:, caches redirected to `.devcache`.

## Phase 1 — Product rules, storage, identity, background planning — DONE

| Step | Scope | State |
|---|---|---|
| 1A | Budget guide vs firm; whole-plan ranking incl. hotel suitability | Done, tested |
| 1B | `version` locking, pins, `lastSearch`, additive migration, `Store` interfaces, both stores, shared contract suite, embedded-Postgres harness | Done, tested on real PostgreSQL |
| 1C | Anonymous + email-link accounts, cookie sessions, ownership (404), export/delete, Origin check, `TRUST_PROXY`, limits, quotas, audit, housekeeping | Done, tested |
| 1D | Background runs: lease queue, worker (in-process or separate), cancel/timeout/`AbortSignal`, superseded results, replan runs, persistent pins | Done, tested |
| Web | Progress/cancel, pins UI, released-pin notices, budget wording, sign-in, trips page, account controls | Done; not browser-tested |
| 1E | Docs, `.env.example`, compose worker, CI Postgres job, smoke script | Done; compose/CI not executed |

## Phase 2 — Multi-agent planning architecture — DONE (with the caveats in `PROJECT_STATUS.md`)

Defined by the user (not proposed by Claude): introduce the multi-agent trip-planning architecture,
explicitly **not** browser testing, provider verification, Docker verification or general hardening,
and **no RAG**. LLMs/agents understand, interpret and explain; deterministic code owns every
calculation, price, date, constraint, validation, state change, persistence and authorisation.

| Piece | State |
|---|---|
| Requirements Agent (hard vs soft, missing, conflicts; quoted evidence; rule fallback) | Done, tested |
| Transport Agent (modes to consult, preferred mode; impossible requests before any call; ₹0 self-drive preserved) | Done, tested |
| Accommodation Agent (grounded soft guidance; no rooms/prices) | Done, tested |
| Activity / Destination Agent (closed interests → place types; pace) | Done, tested |
| Budget / Optimisation Service (deterministic; Phase 1 guide/firm rules preserved) | Done, tested |
| Itinerary planning service | The existing engine scheduler, reached through the `PlanningServices` port (not re-implemented) |
| Validation Service (independent final gate; blockers, re-rank) | Done, tested |
| Synthesis Agent (facts-only, fact-checked, template fallback) | Done, tested |
| Deterministic Orchestrator (fixed order, trace, partial failures, cancellation, `replan` with pins) | Done, tested |
| Integration (run service, session fields, two endpoints, `structured()` LLM boundary, web boxes, docs) | Done, tested; both smoke topologies pass |
| Untrusted-agent and prompt-injection boundaries | Done, tested with scripted hostile models; **not** run against a real model |

Explicitly not built (by instruction): RAG, vector database, embeddings, microservices, payment,
booking, agent frameworks, a single master planner agent.

## Phase 3 — Real external APIs/tools and the provider architecture — DONE in code and tests; no external service live-verified

Defined by the user. Real integrations behind interchangeable, isolated adapters, so a failing
service does not fail the request, with deterministic fixtures for development and CI. **No RAG.**
Extends the existing provider interfaces; nothing parallel was added.

| Piece | State |
|---|---|
| Statuses that tell *not available*, *failed*, *timed out*, *rate limited*, *no results* and *unusable response* apart (`invalid_response` added; `statusClass`) | Done, tested |
| Capability-specific notes (Flights and Hotels are no longer merged; `capability` on every note; per-capability missing-provider wording) | Done, tested |
| Every adapter validates what it reads (Amadeus, OSRM, Nominatim, Google Places/Routes, rail/bus contract); malformed data and non-JSON are `invalid_response`; one bad row is dropped, not the list | Done, tested against hand-written fixtures |
| Failure isolation: `ProviderPolicy` port on the registry; default `IsolatingPolicy` (throws → failures; per-call deadline `PROVIDER_CALL_TIMEOUT_MS`); providers of a capability asked at once; every failure kept; a mode or provider that throws costs itself, not the run | Done, tested |
| Extension points for retries, fallback, rate limiting, circuit breaking, caching, observability | The port existed; **retries, fallback, rate limiting, circuit breaking and caching were built in Phase 5** through it; observability is Phase 7 and not built |
| Deterministic fixtures and contract tests for every adapter, no network | Done (fixtures are hand-written from vendor docs, **not recordings**) |
| Validation of Nominatim, OSRM, Amadeus, mail/webhook | Done by contract tests; OSRM night tariff and taxi-per-party fixed; webhook redirect refused and timeout told apart. **Not run against the real services** |
| International → flights; domestic → flight, train, bus, own car | Verified by tests; rental car/taxi/ferry remain "possible, no provider" notes |
| Phase 2 fixes: "12 December" read as money; "confirm" vs "firm"; the flaky same-millisecond run ordering | Fixed and regression-tested (a second reader in `@trip/llm` had the same bug) |
| `.env.example`, `docs/providers.md`, `SECURITY.md` | Updated |

## Phase 4 — Advanced trip planning and optimisation — DONE in code and tests, on the existing engine

Defined by the user. A complete trip, not a list of places; deterministic and explainable; **not**
"pick the cheapest"; **no RAG**; the existing scheduler/planner was extended, not replaced.

| Piece | State |
|---|---|
| Requirement flow: source → destination → dates → travellers (the trip itself) → budget and currency → budget level → **safety** (new question) → transport → accommodation → **anything else** (new question) | Done, tested; both new questions optional |
| Compare feasible transport (flight/train/bus/own car; flights for international) and accommodation | Done (`optimize.ts`), tested |
| Choice that is not cheapest-only: three readings of "best"; travel style moves the balanced pick; rooms chosen for what was asked before price; safety-first ranking | Done, tested |
| Estimate trip cost; keep within a firm budget when feasible; report clearly when it cannot be | Done: most preferred combination that fits, else the closest marked as breaking the limit; `feasibility` in numbers |
| Avoid impossible schedules and overlaps; account for arrival/departure; hotel check-in/out; travel time between activities | Fixed and tested (activities after their travel leg, whole-visit opening hours, meals, check-out before an early departure); local legs are estimates |
| Multiple travellers | Vehicles per party for transfers, rooms that sleep the party judged room by room, group warnings |
| Coherent day-by-day itinerary; explain choices | Done; every plan carries `choices` |
| Replanning keeps user constraints (dates, pins, cancellation, other workflow operations) | Existing consent/pin/replan flow retained; optimiser respects kept parts; tested |
| Real-world failure handling (provider failure, timeout, rate limit, partial availability, stale data, invalid data, impossible/conflicting constraints, missing inventory, duplicate/concurrent requests, cancellation, long jobs) | Basic safe behaviour and reporting in place, tested where the infrastructure exists; **retries, fallback, caching and circuit breaking were built in Phase 5**; observability is not built |

## Phase 5 — Reliability, scalability, performance and resilience — DONE in code and tests; nothing live-verified

Defined by the user. Built on the Phase 3 provider architecture and the Phase 4 planner. **No RAG.** Design and failure
table: `docs/reliability.md`.

| Piece | State |
|---|---|
| 5.1 Retries: transient failures only, safe requests only, bounded count, jittered capped backoff, deadline-aware, per-host retry budget; 429/4xx never retried | Done, tested (33 tests; four mutations checked) |
| 5.2 Provider fallback (routing Google → OSRM; geocoders), original failures preserved, provenance names the answering provider, all-fail lists everything | Done, tested (registry wiring with real adapters and a stubbed network) |
| 5.3 Circuit breaker per provider and capability (CLOSED/OPEN/HALF_OPEN, threshold, recovery, probes; `local` failures uncounted; 429 honoured), inside `ResilientPolicy`; also on the language model | Done, tested |
| 5.4 Rate limiting: person **and** address, per-route policies, Redis-shared counters with per-process fallback, `RateLimit-*`/`Retry-After`, anonymous-cookie loophole closed | Done, tested (concurrency, two instances sharing counters, Redis failure); **Redis itself not run** |
| 5.5 Idempotency (`Idempotency-Key`) on create, plan, modify, consent, requirements, cancel, magic link | Done, tested (first, duplicate, same/different payload, concurrent, per-person) |
| 5.6 Overload: bounded queue, admission control, per-user active cap, stale-queue expiry, provider-request ceiling, body limit, cancellation reaches every request | Done, tested (incl. worker concurrency bound, store outage, queue-full change) |
| 5.7 Caching: places, routes, things to do; TTL, namespaced keys, schema-checked, bounded, isolated, Redis-shared | Done, tested (hit/miss/expiry/isolation/failure/poisoning) |
| 5.8 Database/state: optimistic-lock stress test, no silent overwrite, `deleteSession` error, no stuck "searching" trip, new store methods on real PostgreSQL; no index needed | Done, tested (memory and PostgreSQL) |
| 5.9 Layered timeout budgets (search → stage → provider → attempt) | Done, tested deterministically |
| 5.10 Performance: measured first, −54% wall time, 13 → 9 provider calls; list/count payloads reduced | Done; `measure-plan.ts` |
| 5.11 Failure modes (timeout, 5xx, 429, network, malformed, all-down, Redis down, DB failure, duplicates, concurrency, cancellation, partial results) | Done, tested |

## Phase 6 — Security, abuse protection and data protection — DONE in code and tests; not penetration tested

Defined by the user. Threat model first (`docs/threat-model.md`); `SECURITY.md` rewritten. **No RAG, no booking, no traveller documents.**

| Piece | State |
|---|---|
| 6.1 Threat model (all 25 threats the user listed evaluated) | Done: `docs/threat-model.md` |
| 6.2 Authentication: absolute session life, sign out everywhere, lockout after refused links, uniform errors, no enumeration, cookie flags | Done, tested |
| 6.3 Authorization / IDOR / BOLA: every trip route as stranger and as no one, forged cookies/headers, mass assignment, model cannot act for a stranger | Done, tested (40 tests); **no vulnerability found** |
| 6.4 Input validation: strict bodies, bounded strings, UUID ids, listing limits, hidden characters removed, prototype pollution | Done, tested (77 tests) |
| 6.5 SSRF: guard, redirect rule, config validation, response-size cap | Done, tested (74 + 33 tests) |
| 6.6 Secrets: env-only, start-up validation, no secret in responses/logs/errors, `.env.example` placeholders, history scan | Done, tested; gitleaks not available here |
| 6.7 Web: CSP + headers, no unsafe rendering (static tests), link scheme check | Done; **not clicked through in a browser** |
| 6.8 API: consistent errors, payload/pagination limits, `no-store`, provider endpoints gated | Done, tested |
| 6.9 LLM boundary: tag/hidden-character-proof data blocks, closed intents, owner checked before the model, no tools, breaker, redirects refused | Done, tested with scripted models; **no real model run** |
| 6.10 PII: address only as keyed hash; email only for signed-in; not copied anywhere; no documents/payment | Done, tested |
| 6.11 Logging: minimal request line, redaction at two depths, structured security events | Done, tested |
| 6.12 Abuse: person+address limits, sign-in email limits, per-address anonymous search cap, failed-sign-in lockout | Done, tested |

## Phase 7 — Observability, metrics, tracing and operations — DONE in code and tests; no collector or Prometheus used

Defined by the user (with Phase 8). Answers "what is the system doing, and why is it slow or failing?". Design:
`docs/observability.md`. One system, no vendor lock-in: the OpenTelemetry API in the libraries, an SDK installed only by
the API and worker, an own metrics registry rendered as Prometheus text.

| Piece | State |
|---|---|
| 7.1 Structured logging: one logger (Phase 6 redaction reused), standard fields (service, environment, operation, request/run/trace/span ids, provider, capability, status, duration, retry count, error category, queue wait, planning duration) | Done, tested |
| 7.2 Correlation: request id → queued run row → worker → agents → providers → LLM → store; survives the queue and a separate worker process | Done, tested (async run correlation) |
| 7.3 Tracing: spans for HTTP, run, orchestrator, each agent, each provider call (incl. retries, fallback, circuit skips), each LLM call (metadata only), each store operation; W3C `traceparent` stored in the run; inbound `traceparent` ignored | Done, tested with an in-memory exporter; **no collector used** |
| 7.4 Metrics: requests, planning (started/completed/failed/cancelled, duration, queue wait, queue depth), providers (calls, failures by class, latency, retries, fallbacks, circuit opens), cache, rate limits, LLM (calls, latency, failures, tokens, cost only from the operator's own prices), store, knowledge; closed labels, cardinality cap | Done, tested |
| 7.5 Liveness vs readiness (`/live`, `/ready`; readiness ignores optional providers, Redis, the model); token-protected `/metrics` and `/ops/status`; Docker health check on `/live` | Done, tested |
| 7.6 One error taxonomy in logs, metrics, spans and the `X-Error-Category` header; no stack trace in a response | Done, tested |
| 7.7 Performance visibility: slow provider / agent / store / LLM / run (histograms, slow-operation counter and log) | Done, tested |
| 7.8 Alerting: designed, not wired (PromQL, tunable thresholds) | Documented only |
| Telemetry security regression tests: secrets, cookies, Authorization, prompts, requirements, credentials, stack traces, high-cardinality labels | Done: 110 new tests (telemetry 42, providers 22, llm 9, api 37) plus mutation checks |

## Phase 8 — Knowledge (RAG), evaluation, regression and groundedness — DONE in code and tests; no real embedder or model used

Defined by the user (with Phase 7). Answers "is the AI producing correct, grounded, consistent results?". Design, evidence
and limits: `docs/knowledge.md`. **RAG is used only for written knowledge (policies, rules, guides)**: live provider facts
stay with providers, calculations and validation with deterministic code, planning does not call it.

| Piece | State |
|---|---|
| 8.1 Knowledge boundary and pipeline (source → ingestion → chunking → embedding → vector storage → retrieval → reranking → LLM → citation) | Done, documented; new package `@trip/knowledge` |
| 8.2 Controlled ingestion: metadata, hash, version, effective date, authority; de-duplication; never replace newer with older; quarantine (screen); operator script, no endpoint | Done, tested |
| 8.3 Chunking for the content (heading, paragraph, list, sentence; overlap; exact spans) | Done, tested |
| 8.4 Embedder interface with a named space; hashing embedder (offline) and OpenAI-compatible adapter; never mixes spaces | Done, tested; **adapter not verified live** |
| 8.5 One vector store: PostgreSQL exact search behind `KnowledgeStore`, additive migration, namespaces, no per-user data | Done, tested on memory and real PostgreSQL 16 (contract + parity); **Qdrant/pgvector not used (decision for the user)** |
| 8.6 Retrieval: top-k, filters, authority, threshold, weighted confidence gate, staleness, disagreement, "Insufficient verified information." | Done, tested |
| 8.7 Prompt-injection defence for retrieved text (data blocks, layered) | Done, tested; residual risk documented |
| 8.8 Grounded answers: citations only for used sources, verifier, disagreement preserved | Done, tested; verifier is lexical (limits measured) |
| 8.9–8.13 Datasets: 43 answer questions (nine kinds), 26 groundedness pairs, hallucination and injection sets | Done, versioned |
| 8.10 Retrieval metrics (Recall@K, Precision@K, MRR, hit rate) | Done, baseline recorded |
| 8.14 Regression baseline and automatic detection (prompt, embedder, chunking, retrieval settings, re-ranker, model, screen, behaviour) | Done, tested |
| 8.15 A/B benchmarking on the same dataset | Done; results in `docs/knowledge.md` |
| 8.16 Cost and latency (stages, retrieval calls per question, prompt tokens) versus planning latency | Done; offline stand-ins, so a floor |
| API: `POST /v1/knowledge/ask` (off by default, session, owner-only trip, rate limited, fixed 503) | Done, tested (29 tests); smoke-tested through the built ingestion script and PostgreSQL |
| Live evaluation against a real model and embedder | Script exists (`--live`); **never run** |

## Standing constraints for every phase

See `CLAUDE.md`: everything on H:, booking disabled, no push/PR, no destructive DB commands, no
weakened checks, no major upgrades, agents untrusted, ask only in the four cases listed there. **Phases 9 and later are not defined: do not invent them.**
