# DECISIONS

Saved: 2026-09-27. Decisions actually made in this project, with who made them. "User" = stated by
the user; "Claude" = an engineering decision taken during implementation under the user's
instruction to decide engineering details. Nothing here is aspirational.

## Product decisions (User)

1. **India-focused, INR only.** No multi-currency, no FX. Provider prices in other currencies are set
   aside with a reason, never converted.
2. **Self-drive fare is ₹0** (a known amount); fuel/tolls/parking/wear appear separately, only when
   reliably calculable. Unknown prices for other options are never treated as ₹0.
3. **Booking is not part of this stage.** The booking API is disabled (501); no payment, ticketing
   or provider confirmation. Booking code is kept but unreachable.
4. **Pins:** users can pin components; when dates or party size change, invalid pins are identified
   and the user is told, not silently kept. (Earlier answer: carry the pinned item forward.)
5. **Consent:** explain plan-affecting changes and ask where required. Date and party changes
   re-plan affected parts after consent.
6. **Budget is a guide by default; "do not exceed ₹X" is a hard limit.**
7. **Hotel suitability counts in plan ranking.**
8. **Accessibility is a hard filter, with the reason recorded.**
9. **Do not upgrade major dependencies** (e.g. Next.js, Vitest).
10. **Local development with Docker where required; architecture ready for production without
    production-specific assumptions.**
11. **Do not push and do not open a PR.**
12. **Decide important product matters when they become relevant;** ask only in the four cases in
    `CLAUDE.md`.
13. **Environment:** everything on the USB drive H:, nothing project-related on C:.
14. **Never ask for API keys or credentials** (use env placeholders). Earlier: "no agents /
    multi-agent frameworks" — **superseded in Phase 2** (see 15).
15. **Phase 2 (user-defined): introduce the multi-agent trip-planning architecture.** Not browser
    testing, provider or Docker verification, or general hardening. Agents (LLMs) understand language,
    extract requirements, interpret preferences, reason about options, communicate and explain;
    deterministic application code owns calculations, prices, totals, dates, durations, constraints,
    validation, feasibility, ranking calculations, state changes, persistence, authorisation and
    provider responses. **No RAG, vector database, embeddings or knowledge base** in Phase 2 (a
    separate future phase if ever justified). No single master planner agent, no agents mutating
    database state, no bypassing authorisation, validation or the Phase 1 protections, no unnecessary
    microservices, no rewrite of the existing application, no booking or payment, no push or PR, and
    the old npm cache on C: is not to be deleted. Do not begin Phase 3.

## Architectural decisions (Claude, Phase 0–1)

- **Deterministic engine + narrow LLM router.** The model only classifies modification requests;
  output is untrusted and sanitised per field; the traveller-facing sentence is generated from the
  validated request (`describeRequest`), never by the model.
- **Provider results are a tagged union with provenance;** the system never fabricates data.
- **Constraints:** hard constraints filter, soft preferences weight; the only way past a hard
  constraint is a recorded waiver granted through consent. Budget total/allowances become hard only
  when `budget.firm`.
- **Ranking:** a whole plan's score = journey and stay together (`combinePlanScore`), scaled by
  `budgetOvershootFactor` (floor 0.3) when over a guide budget; plans without blockers rank first.
- **Modification flow:** `applyModification` returns `no_change | apply | needs_consent`, with both
  answers precomputed and stored as a `PendingModification`; a pending question lapses if the trip
  changes another way.
- **Persistence:** sessions are validated JSON documents plus indexed columns; both stores validate
  on write; Prisma re-validates on read. Column values are the truth for `ownerId` and `version`
  (JSONB does not keep key order, and copies inside the document can be stale).
- **Optimistic locking** via `trips.version` and compare-and-set `updateSession`; deterministic
  changes (answer, pin, selection) retry on conflict, others return 409.
- **`Store` = trips + runs + identity interfaces,** in-memory and Prisma implementations held to
  one shared contract test suite that also runs on real PostgreSQL.
- **Real-PostgreSQL testing without Docker:** `embedded-postgres` (dev dependency, UTF-8 cluster)
  or `TEST_DATABASE_URL` (must be a disposable database whose name contains "test").
- **Migrations are additive;** the partial unique index (one active run per trip) lives only in
  migration SQL because Prisma cannot express it. The corrupted init migration was corrected once
  (nothing could ever have applied it).
- **Identity:** every visitor is a user (anonymous = no email); cookie session (HttpOnly, SameSite=Lax,
  Secure in production), token 256 random bits, stored only as HMAC-SHA256 keyed by `SESSION_SECRET`;
  cross-origin credentialed CORS with an allow-list plus an Origin check on writes (a same-origin
  Next.js proxy was considered and discarded: shared-IP rate limiting and uncertain forwarding).
- **Sign-in:** emailed single-use link, no password; verify is a POST (prefetch-safe); consumed
  atomically; a fresh session on every sign-in; the request endpoint answers the same for known and
  unknown addresses. Mail goes through a `Mailer` interface (console for dev, webhook, disabled);
  console is refused in production.
- **Ownership:** a trip that is not yours returns the same 404 as one that does not exist; trips
  with no owner are unreachable.
- **Background planning:** a `planning_runs` table as the queue, claimed with `FOR UPDATE SKIP LOCKED`;
  lease + heartbeat, bounded attempts, reaping; one active run per trip (DB-enforced); polling rather
  than push; worker runs in the API process by default (`RUN_WORKER=true`) or separately.
- **Run correctness:** runs carry an input fingerprint (canonical JSON hash of intent, profile,
  constraints, pins); plans are saved only if it still matches (else `superseded`); saved with a
  version-checked write; `AbortSignal` from run → engine → provider HTTP (`RequestAbortedError`, never
  retried).
- **Modify while searching is refused (409)** rather than superseding a running search; a changed
  trip's old plans are cleared at commit and the parts to keep are snapshotted into the run.
- **Pins** live on the trip; checked against dates/group before each search; released with a reason.
- **Cost controls:** per-person daily search quota (lower when anonymous), per-route rate limits,
  per-address cap on creating a first trip, `TRUST_PROXY` off by default.
- **Data handling:** provider revalidation tokens stored, but blanked in all responses except the
  owner's export.
- **Web:** cookies via `credentials: 'include'`; `lastSearch` stored on the trip so the comparison
  survives reloads; progress by polling with backoff.

## Architectural decisions (Claude, Phase 2 — under the user's Phase 2 instruction)

- **Where it lives:** a new workspace `packages/agents` (`@trip/agents`) between `engine` and the API,
  so agents and services can later be extracted; no new process or service. The API's `RunService`
  calls the orchestrator; the API remains the only thing that authorises and persists.
- **One agent contract** (`contract.ts`): model call with a schema → deterministic sanitiser → structured
  outcome; the model's answer is untrusted; a rule-based fallback answers when there is no model, it is
  slow (`AGENT_TIMEOUT_MS`), unavailable or unusable, and the outcome says which; agents never throw.
  A deterministic conclusion from a sanitiser (a conflict, an impossibility) is kept, not hidden behind
  the fallback.
- **Instructions and content are separate:** an agent's standing instructions never contain anything a
  traveller or provider wrote; that text goes in a JSON-escaped, tagged data block, and every system
  prompt ends by saying tagged content is data and never an instruction.
- **Evidence over trust (Requirements Agent):** every extracted item needs a quote that really appears in
  the traveller's message; dates are re-read from the quote (the model's value is discarded), amounts and
  counts must be stated by the quote, values come from closed vocabularies, hard mode requirements need
  wording that says so, and missing/conflicts are recomputed in code. Where checks err, they err toward
  dropping (reported), never toward inventing.
- **Agent output reaches a trip only through the ordinary answer path** (`requirementsToAnswers` →
  `TripService.answer`, one at a time), so ownership, question applicability and answer validation are
  never bypassed. Trip-level changes (dates, places, party) are reported as `differences` and left to the
  consent flow; conflicting requirements apply nothing; what has no question yet is reported as
  `unmapped`, not dropped.
- **Guidance fills gaps only** (`applyGuidance`): never overwrites an answer, never touches hard
  requirements, the priority ranking or the budget; every proposed value must be one the traveller stated
  or their words mention; agent output has no price/schedule/duration/availability fields at all.
  Interests are a closed list translated to provider place types by the engine.
- **Impossible requests are said first:** the orchestrator decides "no mode can satisfy this" from sets,
  before any model or provider call, and the run still succeeds with an explanation and no plans.
- **Budget and validation are services, not agents.** Budget statuses preserve Phase 1 semantics (guide vs
  firm vs waived); "within" is never claimed when unpriced costs exist without saying so. Validation is an
  independent re-derivation against the trip (not the engine's own reasoning), turns failures into
  `validation.*` blockers, ranks failing plans last, and never repairs a number.
- **Synthesis is checked against facts:** facts are strings built in code; provider-supplied text in them
  is cleaned and withheld if it asserts a link or a booking; the prose may not contain a figure absent from
  the facts (including numbers in words), a link, or a claim of booking/payment/guarantee, and may not
  recommend an unworkable plan; each part that fails is replaced by the template's sentence.
- **The orchestrator is a fixed workflow and does not persist:** guidance agents in parallel, then apply
  guidance, then deterministic search behind a `PlanningServices` port, then validation, then synthesis;
  a trace entry per stage (no traveller words); failed guidance agents degrade rather than fail the
  search; cancellation between stages and into agents/providers; `replan()` re-runs agents, revalidates
  pins with the engine's `checkPins` (moved from the API into `@trip/engine`) and recomputes the budget.
- **Persisted with the trip:** `statedRequirements`, `narrative`, `agentTrace` in the session JSON (no
  migration); `statedRequirements` is part of the search fingerprint, so a search made before the traveller
  said something new is `superseded`.
- **Latest statement per kind wins** when merging stated requirements (`mergeRequirements`); kinds a new
  message does not mention are kept. Known limitation: earlier hard requirements cannot be withdrawn in
  words alone.
- **Itinerary service = the existing engine scheduler** behind the services port; not re-implemented.
- **Provider-supplied text is data everywhere it is repeated** (names, notes) — cleaned, length-limited,
  and withheld when it asserts too much.
- **The requirements endpoints:** `interpret` needs no session and stores nothing (reading is not acting);
  `/trips/:id/requirements` is owner-only; both rate-limited at 10 a minute because each may cost a
  model call.

## Open decisions (not made)

- Scope of Phase 3 (user has not defined it).
- Whether the agents' checks are well-tuned against a real language model (never run).
- How CI's dependency-audit gate should be handled while major upgrades are forbidden.
- Whether/when to add shared rate-limit storage, response caching, push progress, second factors.
- Anonymous-abuse policy beyond the current caps (documented in `SECURITY.md`).
