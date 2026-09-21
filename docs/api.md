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
| `internal_error` | 500 | Unhandled. Nothing was booked or charged. |

**Headers**

- `X-User-Id` — optional. Associates a trip with an account. Planning is anonymous by default.
- `Idempotency-Key` — **required** on every booking mutation, minimum 8 characters. A repeated key
  returns the original result rather than creating a second booking.

**Rate limiting** — `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW`, keyed by `X-User-Id` or IP.

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

Set `"skipped": true` with `"value": null` to decline. A skipped question leaves no trace of a
preference — it is recorded as skipped, never as a default.

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
  "interpretation": "Re-planning with price as the first priority. Kept as-is: hotel.",
  "understoodBy": "Anthropic Claude",
  "reSearched": ["outbound", "return", "transfers"],
  "preserved": ["hotel"],
  "requiresConsent": null,
  "plans": [ { "...": "TripPlan" } ],
  "budgetConflict": null
}
```

`understoodBy` is `"rules"` when the deterministic fallback handled it. An unclear request returns
`reSearched: []` and changes nothing.

`requiresConsent` is set when the change would breach a hard constraint — changing party size or
dates invalidates every quoted price, and asking for more comfort under a fixed budget may exceed
it. The plan is not changed until the traveller answers.

### `DELETE /v1/trips/:id`

`204`.

### `GET /v1/places?q=`

Place lookup for autocomplete. `{ "places": Place[] }`.

---

## Booking

Every mutation below requires `Idempotency-Key`.

### `POST /v1/trips/:id/bookings`

```json
{
  "component": "transport_outbound",
  "offerId": "amadeus-flight:1",
  "provider": "amadeus",
  "quotedPrice": { "amount": 960000, "currency": "INR" }
}
```

`201` with a booking in state `draft`.

### `POST /v1/bookings/:id/revalidate`

```json
{ "revalidationToken": "<from the offer>" }
```

Re-prices with the provider. Three real outcomes: still available at the same price
(`revalidated`), available at a different price (`price_changed`), or gone (`unavailable`). The
response `message` is written for the traveller and states explicitly that nothing has been charged.

### `POST /v1/trips/:id/travelers`

An array of `TravelerDetails`. Returns `{ "saved": n }` — identity documents are never echoed back.

### `POST /v1/bookings/:id/events`

```json
{ "event": "USER_CONFIRM", "note": "optional", "providerReference": "optional" }
```

Drives the state machine. An event that is not a declared transition from the current state returns
`409` with what would be valid. A transition into `confirmed` or `ticketed` without a provider
reference is refused.

### `POST /v1/bookings/:id/confirm`

Attempts the provider booking. Requires state `payment_authorized` and saved traveller details.

```json
{ "booking": { "...": "BookingRecord" }, "message": "…", "confirmed": false }
```

`confirmed` is explicit so no client can read a `2xx` as "we have a reservation". With no
booking-capable provider connected this returns `503` and says so — no charge should be captured.

### `GET /v1/bookings/:id`, `GET /v1/trips/:id/bookings`

---

## System

### `GET /health`

`200` or `503`. Reports the store in use, including whether it is in-memory and therefore volatile.

### `GET /ready`

`200` only when the store is reachable and a geocoder is configured.

### `GET /v1/providers`

What is connected, what is not, why, and which env vars each missing one needs. Also reports whether
an LLM is configured, and the data policy string the UI displays.

### `GET /v1/providers/health`

Live probe of each connected provider. `207` if any is degraded.
