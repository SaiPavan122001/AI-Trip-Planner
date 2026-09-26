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

## Phase 3 — NOT DEFINED

The user has not defined Phase 3. **Do not start it unprompted.** Candidates only, not agreed:

- Run the agents against a real language model (key supplied by the user in the environment) and
  measure how the checks treat real output; tune what is dropped versus kept.
- Exercise real providers (Amadeus, Nominatim with a real contact, a rail/bus contract) and verify the
  place-type names the activity mapping uses.
- Browser end-to-end tests (Playwright) and an accessibility pass; Docker/compose verification on a
  machine that has Docker.
- Interview questions for what is understood but not yet applied (latest arrival, earliest departure,
  max stops, free cancellation); scoring/filtering for amenities other than breakfast.
- A shared rate-limit store, provider-response caching, metrics/tracing for runs.
- A knowledge/RAG layer, only if the product later needs one (the user said it is a separate phase).
- Booking prerequisites (encrypted traveller documents, payment and booking providers) — booking is
  still disabled.
- The major dependency upgrades (Next, Vitest) and the failing `npm audit`, once the user allows them.
- Small follow-ups noted in `PROJECT_STATUS.md` (₹0 total for a self-drive-only plan, merged provider
  notes, migration-drift check, fixture dates).

## Standing constraints for every phase

See `CLAUDE.md`: everything on H:, booking disabled, no push/PR, no destructive DB commands, no
weakened checks, no major upgrades, agents untrusted, no RAG unless the user starts that phase, ask
only in the four cases listed there.
