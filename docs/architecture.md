# Architecture

## The shape of the problem

Most travel software is a search interface: pick a mode, pick a date, get a list. That works when
the traveller already knows what they want. It fails at the actual question people have, which is
"given my money, my dates, the people I'm travelling with and what I care about, what should this
trip look like?"

That question is a constrained optimisation over several coupled searches. The transport you choose
decides when you arrive, which decides whether the first day is usable, which decides how many
nights you need. Where you sleep decides what you spend on local travel. The budget applies to all
of it at once. Solving each component separately and adding up the prices gives you a plan that is
individually optimal and collectively wrong.

Wayfare is built around that coupling.

---

## The pipeline

```
  Trip intent  (origin, destination, dates, party size)
        │
        ▼
  Journey classification ──────────► eligible modes + reasons for exclusions
        │
        ▼
  Adaptive interview ──────────────► traveller profile
        │
        ▼
  Constraint extraction ───────────► hard constraints | soft preferences
        │
        ├──────────────┬──────────────┐
        ▼              ▼              ▼
  Transport search  Activity search   (parallel)
        │              │
        │              ▼
        │        Activity centroid
        │              │
        │              ▼
        └────────►  Hotel search (biased to where the days happen)
                       │
                       ▼
                 Ground transfers
                       │
                       ▼
                 Schedule construction (absolute time, per-item timezone)
                       │
                       ▼
                 Cost aggregation + budget conflict detection
                       │
                       ▼
                 Deterministic validation
                       │
                       ▼
                 Alternative plans (budget / balanced / comfort)
```

The last two boxes are more than a sort. **Choosing** what goes into each plan is the deterministic
optimiser (`optimize.ts`): three readings of "best" (cheapest known cost; fewest changes and shortest
time; the best fit for what the traveller ranked, or for their travel style when they ranked nothing),
each over the same real options. It is **not** "pick the cheapest": Budget is one reading of three, the
travel style moves the balanced pick (a luxury trip is not scored on price alone), a room is chosen for
what was asked (breakfast, room type, sleeping the whole party) before it is chosen for price, and a
**firm total budget is kept whenever a combination fits it** by taking the most preferred combination
of journey, return and stay whose known cost fits, and reporting the closest (marked as breaking the
limit) when none does. Every plan carries `choices`: what it chose, why, and what it passed over, built
in code from the offers and rules actually applied.

**Feasibility** (`feasibility.ts`) reads what the search found and says whether the trip can be done as
asked, changing nothing: which requirement ruled out every journey (with the reasons), that a source
failed and options may be hidden, that a stay could not be searched (not connected) versus found none,
that even the cheapest journey and stay found cost more than the budget (in numbers, with what to
raise), rooms that may not sleep the group. It is on `lastSearch.feasibility` and in the explanation.

Three orderings in that diagram are deliberate and load-bearing:

**Classification precedes questioning.** "Would you consider a train?" is a nonsense question for
Hyderabad to Paris and an expensive omission for Hyderabad to Bengaluru. The set of eligible modes
is computed from the route before the traveller is asked anything, and it drives which questions
exist at all.

**Activities precede accommodation.** Where you will spend your days determines which
neighbourhood it makes sense to sleep in. Searching hotels first and fitting activities around them
inverts the dependency and produces the classic result: a cheap room half an hour from everything.

**Validation follows everything, including the AI.** The model may rank, explain and interpret. It
may not certify that an itinerary is physically possible. The last step before a plan reaches a
traveller is arithmetic over instants and constraints.

---

## The decision model

Constraints are split into two kinds, and the split is the whole design.

**Hard constraints** are filters, applied before anything is scored:

| Kind | Source |
|---|---|
| `max_total_budget`, `max_transport_budget`, `max_accommodation_budget` | a **firm** budget only ("do not exceed") |
| `fixed_departure_date`, `fixed_return_date` | trip intent |
| `traveler_count`, `required_rooms` | trip intent, room question |
| `required_accessibility` | accessibility question |
| `required_free_cancellation` | cancellation question |
| `excluded_transport_mode` | mode question, or a modification |
| `max_stops`, `required_checked_bags` | transport questions |
| `latest_arrival_time`, `earliest_departure_time` | timing preferences |

The two time windows apply to every leg, outbound and return, and are read in local time where each
departure and arrival happens (`time-windows.ts`). "Arrive by 22:00" means by 22:00 on the day the leg
leaves, so an overnight leg arriving at 06:00 does not meet it. The transport filter and the validator
share that one definition. Accessibility needs are also hard: a hotel that does not publish that it
meets a stated need is dropped with a recorded reason, and the validator blocks any plan that reaches
it anyway. Silence from a provider is not treated as a yes.

A plan that violates one is not a worse plan; it is not a plan. The only way past a hard constraint
is an explicit, recorded waiver (`ConstraintSet.waivers`), granted by the traveller in response to a
specific question. `grantWaiver` is the only function that can add one; it is called only when the
traveller answers yes to a consent question (see below), and a new total budget withdraws an earlier
waiver of the old one.

**A budget is a guide unless it is firm.** `BudgetEnvelope.firm` is false by default: the total and the
derived allowances then only steer ranking. A plan over a guide is shown with an `over_budget_guide`
warning and its score scaled down by how far over it runs (`budgetOvershootFactor`, floored so a plan
that is worth it can still win), and nothing is filtered. When the traveller says "do not exceed",
the same figures become the hard constraints above: unaffordable parts are filtered with a reason and
a plan over the total carries a `budget_exceeded` blocker. Whole plans are ranked on the journey and
the stay together (`combinePlanScore`), so hotel suitability counts as much as the flight.

The budget figures the traveller actually states are the total and the daily allowance. The transport
and accommodation allowances are *derived* from the total and travel style, are re-derived whenever the
total changes, and are never fed back in as if the traveller had stated them.

**Soft preferences** are weights, applied during scoring: the priority ranking, preferred cabin,
carrier preferences, hotel category inferred from travel style, scenic routing, breakfast.

The distinction shows up in the code as two different mechanisms rather than two different
thresholds. `applyHardConstraints` returns `{ kept, dropped }`, where every drop carries a
human-readable reason that is shown to the traveller. `scoreTransportOffers` returns a ranked list
with a per-priority breakdown. Neither can do the other's job.

### Ranking, not weighting

Travellers rank priorities; they do not assign weights. People are reliably good at ordering and
reliably bad at saying "cost is 0.6 and comfort is 0.4". `priorityWeights` converts position to
weight on a gentle decay (`1 / (1 + i × 0.6)`), chosen so a third-ranked priority still matters
rather than rounding to irrelevance.

Every dimension is normalised against the candidate set actually returned, so a score means "best
available for this search" and never an absolute claim about the world.

### Safety without invented scores

"Safest" does not consult an imaginary safety index. It scores properties of the itinerary itself:
arrival hour, number of changes, whether a transfer lands late at night. For accommodation it uses
published guest ratings where a provider supplies them and sits at neutral where none exist, rather
than penalising a property for its provider's silence. The UI states that basis. Nowhere does the
system assert that a place is safe.

---

## Where the AI sits

The LLM has exactly one job: turning what a traveller typed into a structured `ModificationRequest`.
It is a router, and what it returns is **untrusted input**.

```
  "make it cheaper but keep the hotel"
        │
        ▼
  LLM (or keyword fallback)
        │
        ▼
  { intent: 'reduce_cost', pinnedComponents: ['hotel'] }
        │
        ▼
  sanitizeModificationParameters()  ── every field checked against domain
        │                              rules; invalid ones dropped and logged
        ▼
  applyModification()  ── deterministic: works out the whole change first:
        │                  what is kept exactly, what is re-searched, what
        │                  pinned parts must be released and why, and
        │                  whether the traveller has to be asked
        ▼
  generatePlans()      ── real provider searches, for the unpinned parts only;
        │                  kept parts are used as they were, with their
        │                  original retrieval date
        │
        ▼
  validateItinerary()  ── deterministic; has the final word
```

The boundary is enforced by the type system. `LlmProvider` exposes a single method, `extract`, which
takes a Zod schema and returns a value validated against it. There is no free-text completion
method, because free text is how model output ends up displayed to a traveller as if it were fact.

Everything the model is asked is a classification with a closed set of answers. Ambiguity resolves
to `unknown`, which makes the system ask rather than act — a wrong guess would silently re-search
and replace parts of a plan the traveller was happy with.

What this does and does not protect against:

- The traveller's message is JSON-escaped inside a delimited block and the prompt says it is data,
  not instructions. That reduces prompt injection; it does not eliminate it. The real defence is that
  a manipulated model can only name an intent and closed-set parameters, each validated on its own,
  and the engine (not the model) decides what that means. Nothing the model says can set a price,
  skip a hard constraint or reach the traveller as text.
- The sentence shown to the traveller is written from the validated request. An earlier version
  showed the model's own sentence, which let a crafted message make it say things such as "your
  booking is confirmed".
- A model that misbehaves, times out (`LLM_TIMEOUT_MS`, default 20 s) or returns something invalid
  falls back to the keyword rules. That fallback is logged with its reason for operators, so a
  silent, permanent fall back after a provider or model change would be noticed.

Free text is still a risk when it later appears in prompts: the accommodation location preference
is a bounded, single-line string today, and future agents must treat every stored string as data.

### Changes that need consent

A change that would break something the traveller set is worked out in full and stored on the trip
as a pending question with both answers precomputed. Nothing changes until it is answered:

- **New dates or group size**: yes re-plans transport and accommodation for the new trip, and
  releases any pinned item that was tied to the old one, saying so up front; there is no "no" change.
- **A comfort upgrade under a firm budget**: yes shows options above the budget (recorded as a
  waiver); no keeps the budget firm. With a budget that is only a guide no question is needed, because
  over-budget plans are already shown.

`POST /v1/trips/:id/modify/consent` answers it. A question lapses if the trip changes another way
first, so accepting it later cannot silently undo that change.

With no model configured, `interpretModificationByRules` handles the same job with keyword matching.
Blunter, entirely predictable, and the response says which one answered. Planning itself is
unaffected either way, because planning never used the model.

---

## Planning agents

Planning is done by a small number of **bounded agents** working with **deterministic services**, coordinated by one **orchestrator**. It lives in `packages/agents` (`@trip/agents`), between the engine and the API, and is plain code: there is no agent framework, no agent that plans the whole trip, and no agent that calls another.

The division of labour is the rule the rest follows. Agents understand language, interpret preferences and explain. Code does everything that has a right answer: prices, totals, dates, durations, constraints, validation, ranking, state changes, persistence and authorisation. An agent's output is never the source of truth for any of those.

```
what the traveller wrote
        │
 Requirements Agent ──▶ checked in code ──▶ answers (the interview's own door) + stated requirements
        │
 search starts (background run)
        │
 Orchestrator ─┬─ Transport Agent ─┐
               ├─ Accommodation Agent ├─ guidance, checked; fills gaps in soft preferences only
               └─ Activity Agent ──┘
        │
 plan search   (engine: providers, itinerary, cost, its own validation)     ← deterministic
        │
 Validation Service (independent gate: dates, party, currency, arithmetic, hard constraints, kept parts)
        │
 Synthesis Agent ──▶ fact-check ──▶ narrative (template if anything fails)
        │
 saved on the trip by the run service, under its own version and fingerprint checks
```

**The agent contract** (`contract.ts`). Every agent is the same shape: ask a model for a schema (the traveller's and providers' words go in a delimited, JSON-escaped data block, never in the instructions); treat the answer as untrusted and check every value in code; if there is no model, or its answer is unusable, a deterministic fallback answers and the outcome says so; return a value, never throw. An outcome is `ok` with data, what was dropped, and warnings, or an error with a code (`invalid_output`, `unavailable`, `timeout`, `aborted`, `missing_data`, `conflict`, `impossible`) and a sentence written for a traveller. No agent touches a store, a provider or a secret.

**Requirements Agent.** Reads a message into hard requirements and soft preferences, each with a quote of the traveller's own words. The checks that make it safe to trust: the quote must really be in the message; a date is re-read from its quote (the model's value is not used) and only if the quote names one; an amount only if the quote states it; a count only if the quote contains it; every requirement comes from a closed vocabulary and its quote must talk about that very thing, and, for ruling a mode out or insisting on one, must use the words that say so ("we like trains" excludes nothing); what is missing and what conflicts is worked out afterwards in code, so a model cannot hide a gap. Its output reaches a trip only as answers, applied one at a time by the ordinary `answer` path.

**Transport, Accommodation and Activity Agents.** Each turns what the traveller said into *guidance*, and guidance can only fill what the traveller left empty (`applyGuidance`): it never overwrites an answer, never touches a hard requirement, the priority ranking or the budget. Every value must be one the traveller stated or their words mention. The set of transport modes to consult is decided in code (allowed by the journey, minus what was ruled out); a request nothing can meet ("only by train" on a journey with no train) is reported before any model or provider is called. Activity interests are a closed list that the engine turns into provider place types; the agent names no place. None of them can carry a price, a schedule, a duration or an availability: their output has no such field.

**Budget service.** Arithmetic, not an agent. It states exactly where a plan stands: no budget, within, over a guide, over a firm limit, or over a limit the traveller agreed to pass, and whether the total is complete. "Within budget" is never said when it is not, or without saying what the total leaves out.

**Validation service.** A second, independent check of a finished plan, written against the trip rather than the engine's reasoning. Failures become blockers on the plan, which sorts last and is never described as workable. It marks; it never repairs or edits a number.

**Synthesis Agent.** Writes prose from a facts object built in code. What it writes is checked part by part: no number the facts do not contain (including numbers spelled in words), no link, no claim that anything was booked, paid for or guaranteed, no recommendation of a plan that cannot be carried out. Provider-supplied text (a hotel's name, a note) is cleaned and left out if it asserts too much. A failing part is replaced by the template's plain sentence.

**Orchestrator.** A fixed workflow (`orchestrator.ts`): order and control flow are code. A guidance agent that fails costs guidance, not the search. Cancellation is honoured between stages and passed into agents and providers. Every stage leaves a trace entry (stage, outcome, source, timing, a sentence written in code; never the traveller's words), saved with the trip. It returns a result and does not persist: the run service decides what to save. `replan` re-runs every agent for the changed trip, revalidates pins with the same rules as the API (a pin that no longer fits is released with a reason, carried into the explanation), and the budget is recomputed because the plans are new.

**Where untrusted text goes.** The traveller's message reaches the Requirements Agent as data only. The traveller's quoted words reach the guidance agents as data only. Facts (which include provider-supplied names and notes) reach the Synthesis Agent as data only. Nothing external is ever concatenated into an instruction, and nothing an agent returns is acted on before it has been checked. This establishes the boundaries; it is not a complete defence against prompt injection, and the design depends on agents having too little authority for manipulating them to be worth much.

---

## Provider failures

Every provider call goes through the registry's `ProviderPolicy`, and every capability is asked of all
its providers at once. A provider that throws, hangs, is rate limited, answers with nothing, or answers
with data that does not match its schema costs the search *that provider's results* and adds a note
that says which of those it was, for which capability. The search still returns the plans it can build,
and the run fails only when something the planner itself owns breaks. Since Phase 5 the policy also gives
each call a share of the search's time, retries safe requests within it, opens a circuit breaker on a
provider that keeps failing, falls back between providers that can answer the same question, and caches the
answers that are safe to keep; see [reliability.md](reliability.md) and [providers](providers.md). Metrics
and tracing are Phase 7.

## Never fabricating data

This is enforced structurally rather than by convention.

Every provider call returns `ProviderResult<T>`, a union of exactly one success shape and one
failure shape:

```ts
type ProviderResult<T> = ProviderOk<T> | ProviderFailure;
```

`ProviderFailure` carries a status (`not_configured`, `unavailable`, `no_availability`,
`rate_limited`, `timeout`, `price_changed`, `booking_unavailable`, `unsupported_route`, …), the
provider that failed, and a message written for a traveller. There is no code path that converts a
failure into data. Failures propagate to `session.providerNotes` and are rendered verbatim under
"What could not be searched".

Every success carries `ProviderProvenance`: which adapter, when it was retrieved, how long it stays
valid, and any attribution the provider's terms require. That provenance is displayed next to
prices in the UI.

Where a figure is modelled rather than quoted — a taxi fare from a configured tariff, a meal from a
stated daily allowance, a drive's running cost from a vehicle profile — it is marked
`costIsEstimate`, carries an `estimateBasis` naming the configuration it came from, and is totalled
separately as `cost.estimatedPortion`. The UI gives estimates their own colour, used for nothing
else.

Null means "the provider did not say", and is treated differently from zero. A fare whose baggage
allowance is unstated is kept in the results with the gap recorded, because dropping it would hide a
real fare; a fare that states one bag when two are required is dropped with that reason.

---

## Time

Every itinerary item stores an absolute UTC instant plus the IANA timezone it happens in. Scheduling
is comparison of instants; display is formatting an instant in a zone.

The alternative — carrying local wall-clock strings — breaks the moment a trip crosses a zone or a
DST boundary, which is exactly when a traveller most needs the times to be right. `utcFromLocal`
solves the inverse problem by iteration, because a zone's offset depends on the instant being
computed; two passes settle every real case including the hour either side of a DST change.

Provider timestamps arrive in two flavours. With an offset they are unambiguous. Without one they
are local wall time at the place they happen, which is why segments carry their own timezone — and
why `instantFrom` throws rather than assuming UTC when neither is available. Silently treating a
bare timestamp as UTC would shift an entire itinerary.

---

## Money

Integer minor units throughout: paise, cents. `Money` is `{ amount: number; currency: string }` where
`amount` is always an integer.

A trip total sums dozens of components. Floating-point currency drifts, and in a planner that drift
becomes a user-visible discrepancy between the breakdown and the total. Arithmetic across currencies
throws rather than applying an implicit rate.

**INR is the only supported currency.** Wayfare serves India, and there is no exchange-rate source, so
nothing is converted. Trips are created in INR; taxi tariffs and the vehicle profile must be INR or
the service will not start; and provider results in any other currency are set aside at the boundary
(`currency.ts`) with a note naming the provider, so a foreign price is never compared, totalled or
allowed to skip a budget check. Supporting other currencies needs a real FX source first.

**Unknown is not zero.** A cost nobody can price is listed in `cost.notIncluded` (tolls, parking, a
transfer with no fare, entry to a place with no published price, meals with no allowance) and the
total says it is incomplete. The one deliberate zero is driving your own car: the fare is a known
₹0, because nobody sells you a ticket. Fuel and wear are shown separately, as estimates, only when a
vehicle profile makes them calculable; comparisons use the fare plus every cost that can be priced.

---

## Services

```
  Next.js (apps/web)
        │  fetch, typed client
        ▼
  Fastify (apps/api) ── helmet, CORS, rate limiting, request ids,
        │                idempotency keys, structured logging with redaction
        ├──► TripService     — the planning use cases
        ├──► BookingService  — the state machine (kept, not reachable: booking is off)
        ├──► TripRepository  — Prisma (PostgreSQL) or in-memory
        ├──► ProviderRegistry — the only thing that knows which adapters exist
        ├──► TripLlm         — the model boundary
        └──► KnowledgeService — answers from a curated index, with citations (Phase 8; off unless enabled;
                                 nothing in planning depends on it)

  @trip/telemetry — logs, metrics and traces for all of the above (Phase 7), one system
```

`TripRepository` is an interface with two implementations. The in-memory one makes a fresh clone run
with no database. Both stores validate a session against the Zod schema before writing it, so a
document that could not be read back is never stored; the Prisma one also re-validates every document
it reads, so a row written by an older version becomes a loud error rather than an undefined field
somewhere deep in the scheduler.

Planning sessions are stored as a validated JSON document alongside the columns worth indexing.
Bookings are fully normalised: every column is money or provenance.

The store is really three interfaces joined as `Store`: trips (with optimistic locking), the search
queue, and people with their sign-in state. The same contract test suite runs against both the in-memory
store and PostgreSQL, so "the in-memory store behaves like the database" is checked rather than assumed.
The migrations are additive, and are applied to an empty database in CI.

### Identity

Every trip has an owner. A first-time planner gets an anonymous user (a row with no email) and a
session cookie; signing in by emailed link attaches an email to that row, or moves the trips to the
account that already has the email. Only a keyed hash of a cookie or link token is stored. A trip
that is not yours is "not found", like one that does not exist. `Mailer` is an interface (console for
development, a webhook for production, or off), so no mail vendor is built in.

### Background planning

`POST /plan` records a *run* and returns; a worker does the search. The run queue is a table
(`planning_runs`) taken with `FOR UPDATE SKIP LOCKED`, so any number of workers, in the API process
or separate ones, can share it and none takes the same run twice. A worker holds a lease and renews it
while it works; a lapsed lease means a dead worker, and the run is taken up again (bounded attempts).
A partial unique index allows one active run per trip.

Three rules keep it correct. A run is created for a fingerprint of everything the search depends on
(intent, profile, constraints, pins), and its plans are saved only if the trip still has that
fingerprint, otherwise the run is `superseded` and the plans discarded. The save itself is a
version-checked write, redone against the newer trip if it lost a race. And an `AbortSignal` runs from
the run through the engine into every provider call, so a cancelled or timed-out search stops asking
providers rather than merely being ignored.

Pins are stored on the trip. Before a search uses one it is checked against the trip (dates, group);
one that no longer fits is released with a reason and reported to the traveller.

### Observability (Phase 7)

`packages/telemetry` is the one place that knows how the system reports on itself, and the libraries use it without
depending on any vendor: the OpenTelemetry **API** (a no-op until the API or worker installs the SDK), a small metrics
registry with cardinality guards that renders Prometheus text, one error vocabulary (`ErrorCategory`) used in logs, metrics,
spans and the `X-Error-Category` header, and correlation context (request id, run id, trace id) carried by
`AsyncLocalStorage`. A request's trace context is stored in the run row (`params.trace`), so the worker (in any process)
continues the same trace: HTTP request, run, orchestrator, each agent, each provider call, each model call and each store
operation are spans of one trace. Spans and metrics carry closed labels and allow-listed attributes only: never a prompt,
what a traveller wrote, a cookie or a store argument. Liveness (`/live`) touches nothing; readiness (`/ready`) depends on the
store and the queue and not on an optional provider. See [observability.md](observability.md).

### Knowledge answers (Phase 8)

`packages/knowledge` answers a question whose answer is *written down* (a policy, a rule, a guide) from an operator-curated
index, with citations, or says "Insufficient verified information.". It is **not** used for anything live (fares, rooms,
timetables, weather, routing, booking state: providers), nor for anything the engine computes (totals, dates, constraints,
ranking, consent: deterministic code), and planning does not call it. The pipeline is source, ingestion (validate, screen,
version, de-duplicate), chunking, embedding (a named vector space), one vector store (PostgreSQL, exact search, behind
`KnowledgeStore`), retrieval (filters, threshold, confidence gate, staleness, disagreement), lexical re-ranking, an
optional model that proposes claims citing retrieved chunks (retrieved text is escaped **data**), a code-level verifier, and
citation. The layer ships with an evaluation harness (datasets, retrieval, groundedness, hallucination and injection
metrics, a committed baseline with automatic regression detection, A/B comparison, latency and cost). All of it, with the
numbers and the limits: [knowledge.md](knowledge.md).

---

## What is deliberately not built

- **Booking, payment and ticketing.** All of it is off in this release; see [booking.md](booking.md).
  The endpoints answer 501 and store nothing.
- **Passwords, second factors and social sign-in.** Sign-in is an emailed link only. See
  [SECURITY.md](../SECURITY.md).
- **Caching of anything about a person, and of prices.** Only places, routes and things to do are cached
  (see [reliability.md](reliability.md)). Redis holds rate-limit counters and that cache when `REDIS_URL` is set,
  and nothing else: the queue lives in PostgreSQL, and progress is polled rather than pushed.
- **RAG over live facts.** The knowledge index holds written policies and guides only; no price, fare, timetable, availability,
  weather or booking state is ever retrieved from it (see [knowledge.md](knowledge.md)).
- **A second vector database, or an agent framework.** One store (PostgreSQL) behind an interface; pgvector or Qdrant is the
  scale-out path, not a second system today.
- **Adding or removing individual places to visit.** A request to do so says so and changes nothing.
- **Multi-city and open-jaw routing.** The model supports the shape; the search orchestration
  assumes one outbound and one return leg.
- **Seat maps and ancillary selection.** Fare classes are surfaced exactly as providers report them;
  selecting a specific seat is not implemented.
