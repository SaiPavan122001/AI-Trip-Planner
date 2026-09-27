# PHASE PLAN

Saved: 2026-09-27. Status of each phase as of the Git history on branch `phase-0-hardening`.

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
| Extension points for retries, fallback, rate limiting, circuit breaking, caching, observability | **The port exists; none of these is built** |
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
| Real-world failure handling (provider failure, timeout, rate limit, partial availability, stale data, invalid data, impossible/conflicting constraints, missing inventory, duplicate/concurrent requests, cancellation, long jobs) | Basic safe behaviour and reporting in place, tested where the infrastructure exists; **retries, fallback, caching, circuit breaking, observability are not built** |

## Phases 5–7 — not defined

The user has not defined Phases 5, 6 or 7. **Do not invent them and do not start them unprompted.**
Candidates that were mentioned, not agreed, and not necessarily in those phases: real-model
measurement of the agents, live verification of external services, browser end-to-end and
accessibility testing, Docker/compose verification, a shared rate-limit store and caching, metrics and
tracing, booking prerequisites (booking is still disabled), the major dependency upgrades (Next,
Vitest) and the failing `npm audit`.

## Phase 8 (later) — RAG, testing and evaluation

Named by the user as the place where RAG/testing/evaluation work belongs. **Nothing of it exists, and
RAG must not be introduced earlier** (Phases 3 and 4 contain no retrieval, embeddings or vector store).

## Standing constraints for every phase

See `CLAUDE.md`: everything on H:, booking disabled, no push/PR, no destructive DB commands, no
weakened checks, no major upgrades, agents untrusted, no RAG unless the user starts that phase, ask
only in the four cases listed there.
