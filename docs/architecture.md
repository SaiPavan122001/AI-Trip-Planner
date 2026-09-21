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
| `max_total_budget`, `max_transport_budget`, `max_accommodation_budget` | stated budget |
| `fixed_departure_date`, `fixed_return_date` | trip intent |
| `traveler_count`, `required_rooms` | trip intent, room question |
| `required_accessibility` | accessibility question |
| `required_free_cancellation` | cancellation question |
| `excluded_transport_mode` | mode question, or a modification |
| `max_stops`, `required_checked_bags` | transport questions |
| `latest_arrival_time`, `earliest_departure_time` | timing preferences |

A plan that violates one is not a worse plan; it is not a plan. The only way past a hard constraint
is an explicit, recorded waiver (`ConstraintSet.waivers`), granted by the traveller in response to a
specific question. `grantWaiver` is the only function that can add one.

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
It is a router.

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
  applyModification()  ── deterministic: decides what that means,
        │                  which components to re-search, whether a
        ▼                  hard constraint would be breached
  generatePlans()      ── real provider searches
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

With no model configured, `interpretModificationByRules` handles the same job with keyword matching.
Blunter, entirely predictable, and the response says which one answered. Planning itself is
unaffected either way, because planning never used the model.

---

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

---

## Services

```
  Next.js (apps/web)
        │  fetch, typed client
        ▼
  Fastify (apps/api) ── helmet, CORS, rate limiting, request ids,
        │                idempotency keys, structured logging with redaction
        ├──► TripService     — the planning use cases
        ├──► BookingService  — the state machine
        ├──► TripRepository  — Prisma (PostgreSQL) or in-memory
        ├──► ProviderRegistry — the only thing that knows which adapters exist
        └──► TripLlm         — the model boundary
```

`TripRepository` is an interface with two implementations. The in-memory one makes a fresh clone run
with no database; the Prisma one re-validates every document it reads against the Zod schema, so a
row written by an older version becomes a loud error rather than an undefined field somewhere deep
in the scheduler.

Planning sessions are stored as a validated JSON document alongside the columns worth indexing.
Bookings are fully normalised: every column is money or provenance.

---

## What is deliberately not built

- **Ticket issuance.** No connected adapter is authorised to create orders, so the confirm endpoint
  fails with that reason rather than simulating success.
- **Payments.** Card data never reaches the service. The state machine accepts an authorisation
  reference from a PSP and nothing else.
- **Multi-city and open-jaw routing.** The model supports the shape; the search orchestration
  assumes one outbound and one return leg.
- **Seat maps and ancillary selection.** Fare classes are surfaced exactly as providers report them;
  selecting a specific seat is not implemented.
