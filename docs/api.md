# API reference

Base URL: `http://localhost:4000` in development.

All request and response bodies are JSON. Money is always
`{ "amount": <integer minor units>, "currency": "<ISO 4217>" }` — ₹1,500.00 is
`{ "amount": 150000, "currency": "INR" }`.

## Conventions

**Errors** share one shape:

```json
{
  "error": {
    "code": "provider_unavailable",
    "message": "Amadeus did not respond in time.",
    "details": [{ "path": "travelers.adults", "message": "Required" }],
    "provider": { "id": "amadeus", "label": "Amadeus", "status": "timeout" }
  }
}
```

`message` is written for a traveller and is safe to display. `details` appears on validation
failures; `provider` appears when a travel provider was the cause.

| Code | Status | Meaning |
|---|---|---|
| `validation_failed` | 400 | Request body did not match the schema |
| `bad_request` | 400 | Valid shape, invalid request |
| `not_found` | 404 | No such trip, plan or booking |
| `conflict` | 409 | Invalid state transition |
| `unprocessable` | 422 | Understood, but preconditions unmet |
| `provider_unavailable` | 503 | A required provider could not answer |
| `planning_timeout` | 504 | The search exceeded `PLANNING_TIMEOUT_MS` |
| `conflict` on a consent answer | 409 | The question is no longer pending |
| `booking_unavailable` | 501 | Booking is not available in this release |
| `internal_error` | 500 | Unhandled. Nothing was booked or charged. |

**Headers**

- `X-User-Id` — optional, and **not authenticated**: it is a label the client chooses, used to group
  trips, and must never be treated as proof of who someone is. There is no authentication yet, so
  anyone who has a trip's id can read and change it.
- `Idempotency-Key` — used by booking, which is not available in this release.

**Rate limiting** — `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW`, keyed by `X-User-Id` or IP. Because
that header is client-supplied it does not stop a determined caller; it is a courtesy limit until real
identity exists.

**Currency** — every amount is in Indian rupees (`INR`). There is no conversion.

---

## Planning

### `POST /v1/trips`

Creates a planning session. This is the only step with required questions.

```json
{
  "originQuery": "Hyderabad, India",
  "destinationQuery": "Paris, France",
  "departureDate": "2026-11-10",
  "returnDate": "2026-11-17",
  "travelers": { "adults": 2, "children": 0, "infants": 0 },
  "currency": "INR"
}
```

`currency` must be `"INR"` (it is the default) and `departureDate` cannot be in the past where the trip
starts; either returns `400`. Dates must be real calendar dates.

`201` with `{ "trip": PlanningSession }`. The session already carries the journey classification and
the first question.

Resolving a place requires a geocoder. If none is configured, this returns `503 provider_unavailable`
rather than guessing a location. If the query cannot be resolved to a country, it returns `400` and
suggests adding one.

### `GET /v1/trips/:id`

`{ "trip": PlanningSession }`.

### `GET /v1/trips`

Trips for `X-User-Id` (or anonymous ones when absent). Query: `limit` (1–50, default 20).

### `GET /v1/trips/:id/question`

The next question and the journey classification.

```json
{
  "questionnaire": {
    "next": {
      "key": "budget.total",
      "kind": "money",
      "prompt": "What is the total budget for this trip, for all 2 traveller(s)?",
      "helpText": "Include transport, accommodation and the things you plan to do…",
      "options": [],
      "currency": "INR",
      "required": true,
      "reason": "Budget is the one constraint that shapes every other decision…",
      "stage": "budget"
    },
    "completeness": 0.07,
    "canPlan": false
  },
  "classification": { "scope": "international", "eligibleModes": ["flight"], "excludedModes": [...] }
}
```

`next` is `null` when the interview is complete. The engine decides which question comes next; the
client renders whatever it is handed. `kind` is one of `single_choice`, `multi_choice`, `ranking`,
`money`, `number`, `boolean`, `text`, `time`.

### `POST /v1/trips/:id/answers`

```json
{ "key": "priorities.ranking", "value": ["cheapest", "fastest"], "skipped": false }
```

`value` shape follows `kind`: a string for `single_choice`, an array for `multi_choice` and
`ranking`, a Money object for `money`, a number for `number`, a boolean for `boolean`.

Every answer is checked against the question as it was asked for this trip before anything is stored:
an option that was not offered, a list outside `minSelections`/`maxSelections`, a fractional or
out-of-range number (`min`/`max`), money in another currency or not above zero, text over
`maxLength` or with control characters, and a question that does not apply to this trip are all
refused with `400`. The error names the question (`details.key`) and never repeats the value. A
rejected answer leaves the trip exactly as it was.

Set `"skipped": true` with `"value": null` to decline a question that is not `required`. Skipping a
required one returns `400`. A skipped question leaves no trace of a preference — it is recorded as
skipped, never as a default, and skipping a question you answered earlier withdraws that answer.

An unknown `key` returns `400`. Returns the updated trip and questionnaire.

### `POST /v1/trips/:id/plan`

Runs the whole pipeline: searches every eligible mode in parallel, finds activities, searches
accommodation biased toward where the days happen, builds and validates itineraries, and produces
alternatives. No request body.

Returns `422` if required answers are still missing, and `504` if the search exceeds
`PLANNING_TIMEOUT_MS`.

```json
{
  "trip": { "...": "PlanningSession" },
  "plans": [ { "...": "TripPlan" } ],
  "comparison": {
    "outbound": {
      "date": "2026-11-10",
      "modes": [
        {
          "mode": "flight",
          "optionCount": 12,
          "cheapest": { "...": "TransportOffer" },
          "fastest":  { "...": "TransportOffer" },
          "bestForYou": { "...": "TransportOffer" },
          "allOffers": [ { "candidate": {}, "score": 0.87, "breakdown": { "cheapest": 0.62 } } ],
          "unavailableReason": null
        },
        {
          "mode": "train",
          "optionCount": 0,
          "unavailableReason": {
            "providerLabel": "Rail provider",
            "status": "not_configured",
            "message": "No rail provider is connected…"
          }
        }
      ],
      "filteredByYourRequirements": [
        { "offerId": "amadeus-flight:3", "reason": "Travels overnight, and you asked to avoid that." }
      ]
    },
    "inbound": { "...": "same shape, or null for a one-way trip" }
  },
  "hotels": { "considered": 14, "filtered": [ { "hotelId": "…", "reason": "Rated 3; you asked for 4 or above." } ] },
  "budgetConflict": null,
  "providerNotes": [ { "provider": "amadeus", "status": "not_configured", "message": "…" } ]
}
```

`unavailableReason` is the important field: a mode with no options always says why, and
"not configured" is distinguished from "nothing available".

When the best plan exceeds the stated budget, `budgetConflict` is populated:

```json
{
  "overBy": { "amount": 2800000, "currency": "INR" },
  "budget": { "amount": 15000000, "currency": "INR" },
  "total":  { "amount": 17800000, "currency": "INR" },
  "adjustments": [
    {
      "id": "switch-transport",
      "label": "Travel by train instead",
      "estimatedSaving": { "amount": 590000, "currency": "INR" },
      "tradeoff": "Adds about 7h to the journey each way.",
      "affects": "outbound"
    },
    { "id": "raise-budget", "label": "Accept a total of ₹1,78,000", "estimatedSaving": null,
      "tradeoff": "That is ₹28,000 above the budget you set. Nothing changes in the plan.", "affects": "all" }
  ]
}
```

Nothing is applied. These are offers; the traveller chooses.

Each plan's `cost.notIncluded` lists costs the total leaves out because no connected source can price
them, each with a reason (tolls and parking for a drive, a transfer with no fare, entry to a place with
no published price, meals when no daily allowance was given). The total is complete only when that list
is empty; an unknown cost is never counted as ₹0. A drive in your own car has a known fare of ₹0, with
fuel and wear listed separately as estimates only when a vehicle profile makes them calculable.

### `POST /v1/trips/:id/select`

```json
{ "planId": "balanced-8-1" }
```

### `POST /v1/trips/:id/modify`

```json
{ "utterance": "make it cheaper but keep the hotel" }
```

```json
{
  "trip": { "...": "PlanningSession" },
  "status": "applied",
  "interpretation": "Understood as a request to make the trip cheaper. Keeping: hotel. Price is now the first thing the planner optimises for. Kept as you asked: hotel.",
  "understoodBy": "Anthropic Claude",
  "reSearched": ["outbound", "return"],
  "kept": ["hotel", "activities"],
  "released": [],
  "consent": null,
  "plans": [ { "...": "TripPlan" } ],
  "budgetConflict": null
}
```

`status` is one of:

| status | Meaning |
|---|---|
| `applied` | The change is saved and plans were rebuilt where needed. |
| `saved` | The change is saved; there was no plan to rebuild, so the next search uses it. |
| `needs_consent` | **Nothing has changed.** `consent` holds a question to answer first. |
| `no_change` | Nothing was changed; `interpretation` says why, or what to say instead. |

`kept` parts of the plan are used exactly as they were, with the date their price was retrieved
noted under `providerNotes`; only `reSearched` parts were searched again. Anything the traveller
pinned is in `kept` unless it could not be, in which case it appears in `released` with the reason
(for example, a hotel that was for the old dates). `interpretation` is written from the validated
request; it is never text produced by a model. `understoodBy` is `"rules"` when the keyword fallback
handled the request.

Supported changes: cheaper, more comfortable, a different way of travelling ("use the train" becomes a
preferred mode; other modes still appear for comparison), a minimum star rating, no overnight
travel, departure or arrival times, a new total budget, new dates, a new group size, priorities, and
replacing one part of the plan. Adding or removing a single place to visit is not supported and says
so.

**Consent.** A change that would break something you set is not applied. `consent` is:

```json
{
  "id": "c3f1…",
  "question": "Change the trip to 2026-12-01 to 2026-12-05? Every price and schedule will be searched again for the new dates.",
  "acceptLabel": "Yes, change the dates",
  "declineLabel": "No, keep my dates"
}
```

The question is also stored on the trip (`trip.pendingModification`), so it survives a reload. A new
`modify` request, a new answer to the interview, or new plans replaces it.

### `POST /v1/trips/:id/modify/consent`

```json
{ "pendingModificationId": "c3f1…", "accept": true }
```

Applies the answer, and returns the same shape as `modify`. Accepting applies exactly what the
question described; declining changes nothing, except that for a comfort upgrade under a budget both
answers act (yes shows options above the budget, no keeps it a firm limit). Answering a question that
is no longer pending returns `409` and changes nothing.

### `DELETE /v1/trips/:id`

`204`.

### `GET /v1/places?q=`

Place lookup for autocomplete. `{ "places": Place[] }`.

---

## Booking

**Booking is not available in this release.** Every route below is registered and answers `501`:

```json
{
  "error": {
    "code": "booking_unavailable",
    "message": "Booking is not available yet. You can plan, compare and adjust trips here, and booking will be added in a later release. Nothing has been booked or charged."
  }
}
```

- `POST /v1/trips/:id/bookings`
- `GET /v1/trips/:id/bookings`
- `POST /v1/trips/:id/travelers` — stores nothing, and traveller names, dates of birth and document
  numbers are not collected
- `GET /v1/bookings/:id`
- `POST /v1/bookings/:id/revalidate`
- `POST /v1/bookings/:id/events`
- `POST /v1/bookings/:id/confirm`

None reads its request body, writes anything or contacts a provider. See [booking.md](booking.md) for
what exists in the code for the release that adds booking.

---

## System

### `GET /health`

`200` or `503`. Reports the store in use, including whether it is in-memory and therefore volatile. When
the database is unreachable it says so in fixed words; the underlying error is logged, never returned.

### `GET /ready`

`200` only when the store is reachable and a geocoder is configured.

### `GET /v1/providers`

What is connected, what is not, why, and which env vars each missing one needs. Also reports whether
an LLM is configured, and the data policy string the UI displays.

### `GET /v1/providers/health`

Live probe of each connected provider. `207` if any is degraded. **Unauthenticated, and some probes call
billed APIs** (Google Places and Routes make a real request), so do not expose it publicly without
authentication or a network restriction.
