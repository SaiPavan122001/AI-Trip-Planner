# PROJECT STATUS

Saved: 2026-09-27 (after Phases 3 and 4). Everything below was checked against the repository and Git state at save time.

## Git state

- Branch: **`phase-0-hardening`** (local only; no upstream configured; nothing pushed; no PR).
- Code HEAD at save time: `5451f24` "Phase 3 and 4: safe provider foundation, and a planner that chooses
  for reasons". The commit after it (if present) only records these four status files.
- 23 commits ahead of `main` with the Phase 3+4 commit included (the status-recording commit is the next
  one). Remote `origin` = `https://github.com/SaiPavan122001/AI-Trip-Planner.git`. No stashes.
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

## Currently being worked on

Nothing is in progress. Phases 3 and 4 are implemented, verified as listed below, and committed. **Phases 5–7 are
not defined; do not invent or start them. Phase 8 (RAG/testing/evaluation) is later; no RAG exists.**

## Tests and checks completed (all executed after the final code change)

| Check | Result |
|---|---|
| `npm run build` (all workspaces incl. web) | exit 0 |
| `npm run lint` | exit 0; 0 errors; 1 pre-existing warning (`no-page-custom-font`, `apps/web/app/layout.tsx`) |
| `npm run typecheck` | exit 0 |
| `npm test` | agents 140, engine 263, llm 33, providers 137, shared 58, api 226 = **857 passed** (Phase 2 baseline 650) |
| `npm run test:integration` (embedded PostgreSQL 16) | 43 passed (includes the new run-ordering test) |
| `node apps/api/scripts/smoke.mjs` and `… --split` | both passed (19 checks each, unchanged) |
| RAG/vector/embedding scan of the Phase 3/4 diff and manifests | nothing found; no dependency or lockfile change |
| Secret scan of the diff | nothing found (tests use `placeholder-*` values) |

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
- **Not built, by design of the phase boundary:** retries, provider fallback, shared rate limiting, circuit breaking,
  caching, metrics/tracing. The `ProviderPolicy` port is the extension point; nothing claims these are solved.
- Validation does not re-check accessibility (the engine enforces it) or that items lie inside the trip
  window.
- **`npm audit` fails at baseline**; the fix needs Next 16 / Vitest 5 majors, which the user forbade.
- **Latent:** fixtures with 2026-11-10 dates will hit `departure_in_past` after that date; the agents'
  tests use 2030 dates and a fixed `TODAY`.
- **Documented security limits** (`SECURITY.md`): anonymous session churn restarts daily counts (bounded
  by per-address limits); rate-limit counters are per instance; sign-in is an emailed link only;
  pre-accounts trips are unreachable; `/v1/providers/health` is public (5/min).
- **Observed, not investigated (Phase 1):** a self-drive-only plan with no hotel provider shows a ₹0
  counted total with the unpriced costs listed as not included. (The Flights/Hotels note merge was fixed in
  Phase 3.)
- The user asked that the old npm cache on C: **not** be deleted; it was not. C: had 2.5 GB free at the
  last check (it had dropped to 345 MB during Phase 1, for reasons outside this project).
- Redis is unused; booking remains disabled; migration drift (schema vs SQL) is not checked
  automatically.

## Exact next step when a new session starts

1. Read `CLAUDE.md`, this file, `PHASE_PLAN.md`, `DECISIONS.md` (and `SECURITY.md`, `README.md`, `docs/` when the
   work touches them). Do not ask the user to paste them.
2. `source "/h/Projects/Mutli Agent AI Trip Planner/.devcache/env.sh"`, then `git status` and
   `git log --oneline -5`; confirm branch `phase-0-hardening` and that `5451f24` is in the history (the newest
   commit may be the one that records these status files). Check C: free space.
3. If the tree is not clean, find out why before touching anything.
4. **Do not start Phases 5–7 or any new scope on your own** (they are not defined), and **do not introduce RAG**
   (Phase 8, later). Tell the user Phases 3 and 4 are complete with the caveats above and ask what they want
   next. The most useful single next actions, if the user has no other priority, are (a) run the adapters against
   the real services with the user's own credentials placed in the environment by the user (never ask for them in
   chat), record real responses over the hand-written fixtures and see which schemas need to change, and (b) run
   the agents against a real language model and measure how the checks treat real output.
5. Whatever is done next: run lint, typecheck, build and tests (and `test:integration` if storage or the API
   changed, and both smoke topologies if the request path changed), never claim a pass that was not executed, and
   do not push.
