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
- **A comfort upgrade under a budget**: yes shows options above the budget (recorded as a waiver);
  no keeps the budget firm.

`POST /v1/trips/:id/modify/consent` answers it. A question lapses if the trip changes another way
first, so accepting it later cannot silently undo that change.

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
        └──► TripLlm         — the model boundary
```

`TripRepository` is an interface with two implementations. The in-memory one makes a fresh clone run
with no database. Both stores validate a session against the Zod schema before writing it, so a
document that could not be read back is never stored; the Prisma one also re-validates every document
it reads, so a row written by an older version becomes a loud error rather than an undefined field
somewhere deep in the scheduler.

Planning sessions are stored as a validated JSON document alongside the columns worth indexing.
Bookings are fully normalised: every column is money or provenance.

---

## What is deliberately not built

- **Booking, payment and ticketing.** All of it is off in this release; see [booking.md](booking.md).
  The endpoints answer 501 and store nothing.
- **Authentication and authorisation.** None. Anyone with a trip's link can read and change it, and
  `X-User-Id` is an unauthenticated label. See [SECURITY.md](../SECURITY.md).
- **Caching, queues and background work.** Planning runs inside one request. `REDIS_URL` is accepted
  and Redis runs in the compose file, but nothing uses it yet.
- **Adding or removing individual places to visit.** A request to do so says so and changes nothing.
- **Multi-city and open-jaw routing.** The model supports the shape; the search orchestration
  assumes one outbound and one return leg.
- **Seat maps and ancillary selection.** Fare classes are surfaced exactly as providers report them;
  selecting a specific seat is not implemented.
