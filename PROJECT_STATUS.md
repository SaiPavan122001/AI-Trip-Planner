# PROJECT STATUS

Saved: 2026-09-27. Everything below was checked against the repository and Git state at save time.

## Git state

- Branch: **`phase-0-hardening`** (local only; no upstream configured; nothing pushed; no PR).
- Code HEAD at save time: `d86bee0` "Test the agent contract … and self-drive through the orchestrator".
  The commit after it (if present) only records these four status files.
- 22 commits on the branch before the status commit; ahead of `main`. Remote `origin` =
  `https://github.com/SaiPavan122001/AI-Trip-Planner.git`. No stashes.
- Phase 2 commits: `c32d650` (multi-agent architecture), `d86bee0` (contract and self-drive tests).
- Phase 1 commits: `91b3d14` (budget guide/firm, whole-plan ranking), `e5a4fd9` (accounts, background
  runs, pins, PostgreSQL path), `09683bb` (web, docs, compose worker, CI).
- Phase 0 commits: `ac56815` … `377cf81` plus `b5b193c`, `2302a8c`.

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

## Currently being worked on

Nothing is in progress. Phase 2 is implemented, verified and committed. **Phase 3 has not been
defined and must not be started unprompted.**

## Tests and checks completed (all executed after the final code change)

| Check | Result |
|---|---|
| `npm run build` (all workspaces incl. web) | exit 0 |
| `npm run lint` | exit 0; 0 errors; 1 pre-existing warning (`no-page-custom-font`, `apps/web/app/layout.tsx`) |
| `npm run typecheck` | exit 0 |
| `npm test` | agents 134, engine 189, llm 29, providers 52, shared 30, api 216 = **650 passed** (Phase 1 baseline was 478; every Phase 0/1 test still passes) |
| `npm run test:integration` (embedded PostgreSQL 16) | 42 passed |
| `node apps/api/scripts/smoke.mjs` and `… --split` | both passed, 19 checks each (15 from Phase 1 + 4 new: orchestrator trace and explanation, words applied through answers, missing-info interpretation, requirements kept) |
| RAG/vector/embedding scan of Phase 2 code and manifests | nothing found |
| Imports of `packages/agents` (non-test) | only `@trip/shared`, `@trip/engine`, `@trip/llm`, `@trip/providers` (a type), `zod`; no store, fetch, Prisma or `process.env` |
| Secret scan (`git grep`) | nothing found |
| Changed files | limited to `packages/{agents,engine,llm,shared}`, `apps/{api,web}`, root/CI/Docker build lists, docs and the four state files |
| `npm ci --dry-run` | accepts the lockfile with the new workspace |

Tests that guard the Phase 2 boundaries: invalid/garbage/obedient/unavailable model output for every
agent; prompt-injected traveller text and provider-supplied hotel names; a hostile model produces
byte-identical plan totals; impossible requests make no provider call; conflicting requirements apply
nothing; partial agent failure still plans; validation catches tampered plans (and both engine and
validation independently caught a check-out overlap in a self-drive fixture); pins preserved or
released with a reason on a date change; agents re-run on re-plan; determinism of the deterministic
side (apart from random item ids and timestamps).

## Known issues, gaps and blockers

- **No real language model has run through the agents.** Everything model-shaped was tested with
  scripted fakes and mocked HTTP. How often a good real answer is dropped for want of a quote, and how
  a real model behaves against the checks, is unmeasured. Anthropic's SDK `signal` option and the new
  `LlmInvalidOutputError` paths in `anthropic.ts` are unexercised against the real service.
- **Real external services untested:** Nominatim (needs a real contact in `NOMINATIM_USER_AGENT`),
  Amadeus, Google Maps (the interest → place-type mapping uses Places (New) type names that were not
  verified against the live API), a real mail service.
- **Not run:** Docker (not installed), so compose and the Dockerfiles (now including the agents
  package) are checked by inspection only; the CI workflow has not run; the web UI (including the new
  boxes) was built, typechecked and linted but not clicked through in a browser.
- The rule-based fallbacks are deliberately narrow (plainly stated facts only); a real requirement
  whose quote lacks the words that say it is required is dropped (reported via `droppedCount` /
  `rejected`). Later messages do not withdraw earlier requirements of kinds they do not mention.
- Unmapped requirements (latest arrival, earliest departure, max stops, free cancellation) are
  understood but have no interview question yet; they are reported, not applied.
- Accommodation amenities other than breakfast are noted but nothing scores or filters on them.
- Validation does not re-check accessibility (the engine enforces it) or that items lie inside the trip
  window.
- **`npm audit` fails at baseline**; the fix needs Next 16 / Vitest 5 majors, which the user forbade.
- **Latent:** fixtures with 2026-11-10 dates will hit `departure_in_past` after that date; the agents'
  tests use 2030 dates and a fixed `TODAY`.
- **Documented security limits** (`SECURITY.md`): anonymous session churn restarts daily counts (bounded
  by per-address limits); rate-limit counters are per instance; sign-in is an emailed link only;
  pre-accounts trips are unreachable; `/v1/providers/health` is public (5/min).
- **Observed, not investigated (Phase 1):** a self-drive-only plan with no hotel provider shows a ₹0
  counted total with the unpriced costs listed as not included; `dedupeNotes` merges Flights and Hotels
  "Amadeus not configured" notes into one because their messages are identical.
- The user asked that the old npm cache on C: **not** be deleted; it was not. C: had 2.5 GB free at the
  last check (it had dropped to 345 MB during Phase 1, for reasons outside this project).
- Redis is unused; booking remains disabled; migration drift (schema vs SQL) is not checked
  automatically.

## Exact next step when a new session starts

1. Read `CLAUDE.md`, this file, `PHASE_PLAN.md`, `DECISIONS.md`.
2. `source "/h/Projects/Mutli Agent AI Trip Planner/.devcache/env.sh"`, then `git status` and
   `git log --oneline -5`; confirm branch `phase-0-hardening` and that `d86bee0` is in the history (the
   newest commit may be the one that records these status files). Check C: free space.
3. If the tree is not clean, find out why before touching anything.
4. **Do not start Phase 3 or any new scope on your own.** Tell the user Phase 2 is complete with the
   caveats above and ask what they want next, offering the candidates in `PHASE_PLAN.md`
   ("Phase 3 — not defined"). The most useful single next action, if the user has no other priority, is
   to run the agents against a real language model with the user's own key placed in the environment by
   the user (never ask for the key in chat) and measure how the checks treat real output.
5. Whatever is done next: run lint, typecheck, build and tests (and `test:integration` if storage or the
   API changed, and both smoke topologies if the request path changed), never claim a pass that was not
   executed, and do not push.
