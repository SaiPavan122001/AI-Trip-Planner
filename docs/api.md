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
| `unauthorized` | 401 | Needs a session (account export and deletion) |
| `bad_origin` | 403 | A change came from a site that is not in `CORS_ORIGINS` (or a browser said the request was cross-site) |
| `invalid_json` | 400 | The body was not JSON (a fixed sentence: the parser's own complaint is never returned) |
| `payload_too_large` | 413 | The body is larger than `MAX_BODY_BYTES` (64 KB by default) |
| `unsupported_media_type` | 415 | Only `application/json` bodies are read |
| `not_found` | 404 | No such trip, run or plan. **Also** a trip that belongs to somebody else: the two are indistinguishable on purpose |
| `conflict` | 409 | Invalid state transition |
| `trip_changed` | 409 | Another request changed the trip first; nothing was applied. Reload and retry |
| `run_in_progress` | 409 | The trip is being searched; `details.run` is that search. Wait for it or stop it |
| `consent_stale` | 409 | The question is no longer pending |
| `unprocessable` | 422 | Understood, but preconditions unmet |
| `rate_limited` | 429 | Too many requests from this person or address just now; `Retry-After` and `details.retryAfterSeconds` say how long |
| `daily_search_limit` | 429 | The person has used today's searches (`details.limit`) |
| `daily_search_limit_address` | 429 | This connection has started its share of searches today without signing in |
| `too_many_active_searches` | 429 | The person already has `MAX_ACTIVE_RUNS_PER_USER` searches going |
| `too_many_sign_in_emails` | 429 | Too many links were requested for one address this hour |
| `too_many_failed_sign_ins` | 429 | Too many sign-in links were refused from this address; wait (`Retry-After`) and ask for a new link |
| `busy` | 503 | Every search slot is taken; nothing was queued. Try again after `Retry-After` |
| `idempotency_in_progress` | 409 | A request with this `Idempotency-Key` is still running; ask again after `Retry-After` |
| `idempotency_key_reused` | 422 | This `Idempotency-Key` was used for a different request |
| `invalid_link` | 400 | A sign-in link is unknown, expired or already used (all three look the same) |
| `email_sign_in_unavailable` | 503 | Email is not configured on this server |
| `email_delivery_failed` | 503 | The link could not be sent; the reason is logged, not returned |
| `provider_unavailable` | 503 | A required provider could not answer |
| `booking_unavailable` | 501 | Booking is not available in this release |
| `internal_error` | 500 | Unhandled. Nothing was booked or charged. |

A search that fails does not fail a request: it ends its **run** in `failed` with an `error`
(`planning_timeout`, `planning_failed`, `interrupted`) written for a traveller. See [Searching](#searching-in-the-background).

**Identity** — a trip belongs to the person who made it, and only they can read or change it.

- Everyone who plans gets a private session, held in an `HttpOnly` cookie (`COOKIE_NAME`, default
  `tp_session`). The first `POST /v1/trips` creates it; a visitor who has only looked has nothing.
  The cookie is `SameSite=Lax`, `Secure` in production, and only a keyed hash of it is stored. The
  browser must send credentials (`fetch(..., { credentials: 'include' })`) and the API must list the
  web app's origin in `CORS_ORIGINS`.
- A request that changes something and carries an `Origin` header that is not in `CORS_ORIGINS` is
  refused with `403 bad_origin`. Requests with no `Origin` (curl, servers) are not browsers acting on
  someone's behalf and are allowed; they still need the cookie.
- There is no `X-User-Id`. It was an unauthenticated label and has been removed.
- Only `application/json` request bodies are read, so a cross-site form post cannot reach a route. A
  request that changes something and names no `Origin` but carries `Sec-Fetch-Site: cross-site` is
  refused too.

**Idempotency** — `Idempotency-Key: <8–128 characters of A–Z a–z 0–9 _ . : ->` on `POST /v1/trips`,
`/plan`, `/modify`, `/modify/consent`, `/requirements`, `/runs/:runId/cancel` and `/v1/auth/magic-link`.
The first request with a key does the work and its answer is kept for 24 hours; the same key with the same
request again returns that answer with `Idempotent-Replay: true` and does nothing; the same key while the
first is running is `409 idempotency_in_progress`; the same key with a different request is
`422 idempotency_key_reused`. A request that fails releases its key. A key belongs to the person, the route
and the trip: it can never replay, block or reveal anyone else's. Reads ignore it. A client that retries
must reuse the key of the request it is retrying.

**Rate limiting** — every request is counted twice, and both must have room: for the person
(`RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW`) and for the address it came from whoever the person says they are
(`RATE_LIMIT_ADDRESS_MAX`, higher, because addresses are shared). Clearing the cookie gives a new anonymous
person but not a new address, so it does not restart a limit. The address is only as trustworthy as
`TRUST_PROXY` (see `.env.example`); IPv6 counts by /64; an address is only ever a keyed hash. Expensive routes
have named per-route policies on top (searches, changes, reading words, place lookups, creating trips,
sign-in emails and attempts, account export and deletion: see `apps/api/src/security/rate-limit.ts`). Every
answer carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; a 429 carries `Retry-After`.
Each person may start `PLAN_RUNS_PER_DAY_ANONYMOUS` / `PLAN_RUNS_PER_DAY_SIGNED_IN` searches a day, and an
address `PLAN_RUNS_PER_DAY_PER_ADDRESS` through anonymous sessions. Counters are shared through Redis when
`REDIS_URL` is set; see [reliability.md](reliability.md).

**Overload** — a search is turned away with `503 busy` (and `Retry-After`) when `MAX_QUEUED_RUNS` are already
waiting, and with `429 too_many_active_searches` past `MAX_ACTIVE_RUNS_PER_USER` per person. Nothing is queued
to fail later. Every answer also carries `Cache-Control: no-store` and an `X-Request-Id` (the id that appears in
the service's logs and traces for that request; quote it when reporting a problem). An error answer carries
`X-Error-Category` (`validation`, `not_found`, `authentication`, `rate_limited`, `dependency_unavailable`,
`internal_error`, ...: the same vocabulary as the logs and metrics), so a client or a proxy log can tell a bad request from
an outage without parsing the body. The body itself never carries a stack trace or the cause of a failure.

**Concurrency** — every trip carries a `version`, bumped on each save. A save made from an out-of-date
read is refused (`409 trip_changed`) rather than overwriting the other change. Simple changes (an
answer, a pin, a selection) are redone automatically on the newer trip, so a double-click does not lose
either.

**What is never sent to a browser** — a provider's revalidation token (the key to re-pricing an offer)
is stored with the trip and blanked in every response except the account export.

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

`201` with `{ "trip": PlanningSession }`, and a `Set-Cookie` if the caller had no session. The
session already carries the journey classification and the first question.

Resolving a place requires a geocoder. If none is configured, this returns `503 provider_unavailable`
rather than guessing a location. If the query cannot be resolved to a country, it returns `400` and
suggests adding one.

### `GET /v1/trips/:id`

`{ "trip": PlanningSession, "run": PlanningRun | null }` — the trip and its latest background search,
which may be running, finished or failed. A trip that is not yours is `404`.

`PlanningSession` includes `version`, `pins` (parts the traveller asked to keep), `statedRequirements` (what they said in words, as checked), `narrative` and `agentTrace` (below), and `lastSearch`:
the mode comparison from the latest search (`outbound`, `inbound`, `hotelsConsidered`,
`hotelsFiltered`, `budgetConflict`, `builtAt`), so a screen can be rebuilt from the trip alone.

### `GET /v1/trips`

The caller's own trips, newest first, as **summaries**: `{ id, stage, origin, destination, departureDate,
returnDate, planCount, updatedAt }`. Query: `limit` (1–50, default 20; anything else is `400`). Read a whole
trip with `GET /v1/trips/:id`. `{ "trips": [] }` for someone with no session.

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

The interview follows the order a trip is planned in. The trip itself supplies where from and to, the dates and
the party; the questions then run: money (`budget.total`, `budget.firm`), how the trip should feel
(`style.travel_style`: budget, standard, premium, luxury), safety (`safety.preferences`: `safety_first` puts safety
first in the ranking, `no_late_arrival` rules out arrivals between 23:00 and 05:00), what matters most
(`priorities.ranking`), transport (`transport.*`), accommodation (`accommodation.*`), the traveller's needs
(`traveler.*`), the daily allowance, and finally `other.requirements`: free text (up to 300 characters) shown back on
every plan and never claimed as met, because the planner cannot check it.

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

Starts a search and **returns at once** with a run. No request body. Searching fans out to every
eligible mode, finds activities, searches accommodation biased toward where the days happen, builds
and validates itineraries, and ranks the alternatives, which takes a while, so it runs in the
background (see [Searching in the background](#searching-in-the-background)).

`202`:

```json
{
  "run": { "id": "…", "tripId": "…", "kind": "plan", "status": "queued", "progress": null, "error": null,
           "cancelRequested": false, "createdAt": "…", "startedAt": null, "finishedAt": null },
  "reused": false,
  "pinsReleased": [],
  "trip": { "...": "PlanningSession" }
}
```

- `reused` is `true` when the trip was already being searched for exactly this; you get that run back.
- `pinsReleased` lists parts the traveller had pinned that no longer fit the trip (a hotel for the old
  dates, say), each `{ "component", "reason" }`. They are let go and reported, never kept silently.
  Pins that still fit are used exactly as they are, and are not searched for again.
- `422` if required answers are still missing (`details.nextQuestion`). `409 run_in_progress` if the
  trip is being searched for something else. `429 daily_search_limit` past the daily allowance.

### What a search leaves on the trip

A search runs through the planning orchestrator (see [architecture](architecture.md#planning-agents)). When it succeeds the trip carries:

- `plans` — validated and ranked. Every plan has been through an independent validation gate; one that fails carries `validation.*` blockers in `issues`, sorts last, and is never described as workable. Prices are the engine's: no agent can change one.
- `narrative` — `{ summary, plans: { [planId]: text }, source, builtAt }`, a plain-language account written from the plans' facts. `source` is `template` (written in code), `model` (written by a language model and fact-checked) or `mixed`. Any part that stated a figure not in the plan, a link, or a claim of booking was replaced.
- `agentTrace` — one entry per stage (`transport_agent`, `accommodation_agent`, `activity_agent`, `guidance`, `plan_search`, `validation`, `synthesis_agent`): `status` (`ok`, `degraded` when a fallback stood in, `failed`, `skipped`), `source` (`model` or `rules`), timing, a sentence, warnings, and what was proposed and dropped. It never contains the traveller's words.

- `lastSearch.feasibility` — `{ status: "feasible" | "partial" | "infeasible", findings: [{ code, severity, message, suggestions }] }`.
  It says, in words and numbers, what stands in the way of doing the trip as asked (an excluded journey with the
  reasons, a source that failed, a stay that could not be searched or was not found, a budget below the cheapest
  combination found, rooms that may not sleep the group). It never changes a plan.
- each plan's `choices` — `[{ topic: "outbound" | "return" | "stay" | "room" | "budget", chosen, why, alternatives: [{ label, note }] }]`:
  what the planner chose, the reason, and what it passed over, in words built from the offers actually applied.
- `providerNotes` (and each plan's) — every note carries `capability` (`flights`, `hotels`, `trains`, ...) beside `provider` and
  `status`. `status` includes `invalid_response`: the provider answered with something that could not be used.

A request that cannot be met by anything that exists for the trip (for example "only by train" where there is no train) is reported **before any provider is called**: the run still succeeds, `plans` is empty, and `narrative.summary` says what cannot be done and that nothing was searched.

### Searching in the background

A run has a `status`:

| status | Meaning |
|---|---|
| `queued` | Waiting for a worker |
| `running` | A worker is searching; `progress` is `{ step, label, percent }` in words a traveller can read |
| `succeeded` | The plans are saved on the trip |
| `failed` | Nothing could be built; `error` is `{ code, message }` (`planning_timeout`, `planning_failed`, `interrupted`) |
| `cancelled` | The traveller stopped it |
| `superseded` | It finished, but the trip changed meanwhile, so its plans were **discarded** rather than shown against the wrong trip |

A trip has at most one active (`queued` or `running`) run, enforced by the database. A run holds a
lease that its worker renews; if the worker dies, another takes the run up after the lease lapses, up
to `RUN_MAX_ATTEMPTS` times, and then it fails with `interrupted`. `PLANNING_TIMEOUT_MS` cuts a slow
search short, and cancelling stops provider calls already in flight.

While a run is active the trip cannot be changed by `modify` (`409 run_in_progress`); answers are still
accepted, and simply make the running search `superseded`.

### `GET /v1/trips/:id/runs/:runId`

`{ "run": PlanningRun }`. Poll this (every second or two, backing off) until `status` is not `queued`
or `running`, then read the plans from `GET /v1/trips/:id`.

### `POST /v1/trips/:id/runs/:runId/cancel`

`202` with `{ "run": PlanningRun }`. A queued run is cancelled at once; a running one gets
`cancelRequested: true` and ends as `cancelled` at its next step. Cancelling a finished run returns it
unchanged.

### `PUT /v1/trips/:id/pins`

```json
{ "pins": ["hotel", "outbound"] }
```

Replaces the set of parts of the **selected plan** the traveller wants kept: `outbound`, `return`,
`hotel`, `activities`. Returns `{ "trip", "refused": [{ "component", "reason" }] }`; a part the plan
does not have, and `transfers` (always recalculated), are refused with a reason. Pins survive a re-plan,
a change of plan selection and unrelated answers, and are released, with a reason, when a change
(new dates, a smaller group) makes one impossible to keep.

### Cost, budget and ranking

Each plan's `cost.notIncluded` lists costs the total leaves out because no connected source can price
them, each with a reason (tolls and parking for a drive, a transfer with no fare, entry to a place with
no published price, meals when no daily allowance was given). The total is complete only when that list
is empty; an unknown cost is never counted as ₹0. A drive in your own car has a known fare of ₹0, with
fuel and wear listed separately as estimates only when a vehicle profile makes them calculable.

**Budget.** A budget is a guide unless the traveller says "do not exceed". Over a guide, plans are
shown, flagged (`over_budget_guide`, a warning) and ranked lower; nothing is filtered. Answer
`budget.firm` with `"firm"`, or say "do not exceed ₹X" in `modify`, and it becomes a hard limit: what
cannot fit is filtered with a reason and plans over it carry a `budget_exceeded` blocker. When the best
plan exceeds the budget, `lastSearch.budgetConflict` offers adjustments (never applied automatically):

```json
{
  "overBy": { "amount": 2800000, "currency": "INR" },
  "budget": { "amount": 15000000, "currency": "INR" },
  "total":  { "amount": 17800000, "currency": "INR" },
  "adjustments": [
    { "id": "switch-transport", "label": "Travel by train instead",
      "estimatedSaving": { "amount": 590000, "currency": "INR" },
      "tradeoff": "Adds about 7h to the journey each way.", "affects": "outbound" }
  ]
}
```

Plans are ranked on the journey **and** the stay together (hotel suitability counts as much as the
journey), then on how far over a guide budget they run.

With a **firm** total budget the planner builds each plan inside it when any combination of journey, return
and stay fits (`choices` then carries a `budget` entry saying a more preferred combination was passed over),
and otherwise shows the closest plans marked `budget_exceeded` and says by how much in `feasibility`. It never
loosens the limit itself.

### What the traveller says in words

Two endpoints read a message written in plain language. Each may use a language model (or the built-in rules when there is none), so each is limited to 10 a minute.

**`POST /v1/requirements/interpret`** — `{ "message": "…" }` (1–2000 characters). Changes nothing and needs no session. Returns what was understood and what is missing:

```json
{
  "requirements": { "trip": { "origin": "Pune", "destination": null, "departureDate": null, "returnDate": null, "travelers": { "adults": 2, "children": 0, "infants": 0 } },
                    "budget": { "total": null, "firm": null }, "hard": [], "soft": [ { "kind": "activity_interest", "value": "beaches", "evidence": "beach" } ],
                    "missing": [ { "field": "destination", "question": "Where would you like to go?" } ], "conflicts": [], "complete": false },
  "missing": [ { "field": "destination", "question": "Where would you like to go?" } ],
  "conflicts": [],
  "tripInput": null,
  "understoodBy": "rules",
  "droppedCount": 0,
  "notes": []
}
```

Every item carries `evidence`, the traveller's own words it was read from; an item whose quote is not in the message is dropped, and `droppedCount` says how many were. A date is only accepted if it is named ("12 December"): "next Friday" is reported as missing. `tripInput` is the body for `POST /v1/trips` when nothing is missing and nothing conflicts, and `null` otherwise: a trip is never assembled by guessing. `missing` and `conflicts` are worked out in code and cannot be hidden by a model.

**`POST /v1/trips/:id/requirements`** — the same reading, against a trip the caller owns (`404` otherwise). It is applied through the ordinary answer path: each thing said becomes the answer the interview would have collected and is checked exactly as one is. Returns:

- `applied` — answer keys that were applied. `rejected` — answers the trip refused, each with the reason (for example a question that does not apply to this trip).
- `unmapped` — understood, but no question carries it yet (a latest arrival time, a maximum number of stops, free cancellation); reported, never dropped.
- `keptForPlanning` — interests, pace, preferred mode and stay preferences, kept on the trip (`statedRequirements`) for the planning agents at the next search.
- `differences` — things said about the trip itself (places, dates, party) that differ from it. **Nothing about the trip itself is changed here**: changing dates or the group is a change that asks first, through `modify`.
- `conflicts` — if what was said contradicts itself, **nothing is applied**.

The latest word on each kind of requirement replaces the earlier one. What was said is part of what a search depends on, so a search started before it is `superseded`.

---

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
  "status": "replanning",
  "run": { "id": "…", "status": "queued", "kind": "replan" },
  "interpretation": "Understood as a request to make the trip cheaper. Keeping: hotel. Price is now the first thing the planner optimises for. Kept as you asked: hotel.",
  "understoodBy": "Anthropic Claude",
  "reSearched": ["outbound", "return"],
  "kept": ["hotel", "activities"],
  "released": [],
  "consent": null,
  "plans": [ { "...": "TripPlan" } ]
}
```

`status` is one of:

| status | Meaning |
|---|---|
| `replanning` | The change is saved and new plans are being built in the background; follow `run`. |
| `applied` | The change is saved and needed no new search (everything it touches was pinned). |
| `saved` | The change is saved; there was no plan to rebuild, so the next search uses it. |
| `needs_consent` | **Nothing has changed.** `consent` holds a question to answer first. |
| `no_change` | Nothing was changed; `interpretation` says why, or what to say instead. |

`kept` parts of the plan are used exactly as they were; only `reSearched` parts are searched again.
Anything the traveller pinned (in the request, or earlier through `PUT /pins`) is in `kept` unless it
could not be, in which case it appears in `released` with the reason (for example, a hotel that was
for the old dates) and the pin is dropped. When the trip itself changed (new dates or group), the old
plans are cleared immediately and the new ones arrive when the run succeeds. `interpretation` is written from the validated
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
answers act (only when the budget is firm: yes shows options above it, no keeps it a firm limit). With a
budget that is only a guide, more comfort needs no question. Answering a question that is no longer
pending returns `409 consent_stale` and changes nothing.

### `DELETE /v1/trips/:id`

`204`. Removes the trip with its runs and audit trail.

### `GET /v1/places?q=`

Place lookup for autocomplete. `{ "places": Place[] }`.

---

## Accounts

See [Identity](#conventions) above for how sessions work.

### `GET /v1/me`

`{ "user": { "id", "email", "isAnonymous" } | null, "tripCount", "emailSignIn" }`. `emailSignIn` is
`false` where the operator has not set up email; `user` is `null` for a browser with no session (this
call never creates one).

### `POST /v1/auth/magic-link`

`{ "email": "you@example.com" }` → `202`. Emails a single-use link (valid `MAGIC_LINK_TTL_MINUTES`) that
points at `WEB_BASE_URL/auth/verify?token=…`. The answer is the same for an address with an account and
one without. In development with `MAILER=console` the response also carries `devLink`. Limited per
recipient per hour (`MAGIC_LINK_MAX_PER_HOUR`, however many callers ask), and per person, per address and per
day. Accepts `Idempotency-Key`: a retried request sends one email.

### `POST /v1/auth/verify`

`{ "token": "…" }` → `200` with `{ user, tripsMoved }` and a fresh session cookie. This is a POST rather
than a GET on the link, so a mail scanner or browser pre-fetching the link cannot use it up. A link works
once; a second use (even at the same instant) is `400 invalid_link`, whatever was wrong with it. Eight
refused links from one address lock that address out for fifteen minutes (`429 too_many_failed_sign_ins`).
The trips planned in this browser
before signing in come along: the anonymous account gains the email, or, if the email already has an
account, its trips move there (`tripsMoved`).

### `POST /v1/auth/logout`

`204`. Ends this session and clears the cookie.

### `POST /v1/auth/logout-all`

`204`. Ends every session the person has, on every device, including this one (a lost phone, a cookie that may
have leaked). Needs a session. A session also ends `SESSION_MAX_DAYS` (90) after it began, however often it
was used.

### `GET /v1/me/export`

Everything held about the caller, as a JSON download: the account, every trip, and any bookings.

### `DELETE /v1/me`

`{ "confirm": "delete my account" }` → `204`. Deletes the account and every trip, run, audit event and
session belonging to it. Without the confirmation it is `400` and nothing happens.

---

## Knowledge

### `POST /v1/knowledge/ask`

Answers a question from the curated knowledge index (policies, rules, guides), with citations, or says
**"Insufficient verified information."**. **Off unless `KNOWLEDGE_ENABLED=true`** (`404` as if it did not exist).
It answers only what is *written down*: never a price, fare, timetable, availability, weather or the state of a booking
(those come from providers). It changes nothing (no trip, plan or booking), so it needs no `Idempotency-Key`. Design and
evidence: [knowledge.md](knowledge.md).

```json
{ "question": "How long does a refund take to reach my payment method?", "destination": "Bengaluru", "tripId": "<uuid>" }
```

Strict: `question` is required (1 to 500 characters after cleaning: hidden characters removed, one line); `destination`
(80) and `tripId` are optional; any other field, including anything that looks like an index name or an owner, is a `400`.
Needs a session (`401` without one). A `tripId` must be the caller's own trip (someone else's is `404`, byte-identical to
one that does not exist); it only supplies the destination to prefer when none is given. Which index is read is the
operator's configuration; a request cannot name one.

```json
{
  "answer": {
    "status": "answered",
    "answer": "Approved refunds are returned to the original payment method within 7 to 10 working days.",
    "claims": [{ "text": "Approved refunds are ...", "sources": ["refund-policy@v1#0"] }],
    "citations": [{
      "chunkId": "refund-policy@v1#0", "docId": "refund-policy", "title": "Refund policy", "heading": "Refunds > Timeline",
      "url": "https://example.com/refunds", "reference": "Example Co. Refund Policy v1",
      "sourceType": "operator_policy", "version": 1, "effectiveDate": "2026-01-01"
    }],
    "conflicts": [],
    "notes": [],
    "mode": "extractive",
    "insufficientReason": null
  }
}
```

- `status`: `answered` or `insufficient`. When `insufficient`, `answer` is exactly `Insufficient verified information.`,
  `claims` and `citations` are empty, and `insufficientReason` is one of `empty_query`, `no_index`, `below_threshold`,
  `low_coverage`, `only_outdated`, `model_declined`, `unverifiable`. **It is a normal answer, not an error (`200`).**
- `mode`: `extractive` (sentences quoted from the sources) or `model` (a model's sentences, each checked against the
  sources it cites). What is shown is always one of those two, or the fixed sentence.
- `citations` list only sources a shown claim relies on.
- `conflicts` is non-empty when two sources on one topic disagree; both sides appear in `answer` with their version and
  date, and `notes` says so. The service does not choose between them.
- `notes` are plain sentences written by the service, for example that a matching source is past its review date and was
  not used.
- Limits: `knowledge.ask` (10 a minute and 200 a day per person; 30 a minute and 500 a day per address): `429` with
  `Retry-After`. A failing index or embedder is `503 knowledge_unavailable`, a fixed sentence, `X-Error-Category:
  dependency_unavailable`, and nothing about the cause.

Documents are added by an operator script (`npm run ingest:knowledge -w @trip/api`), never through the API.

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

### `GET /live`

`200 { status, uptimeSeconds }` while the process runs and answers. Touches nothing (no database, no provider): an
orchestrator restarts a container that fails this, and an outage of a dependency must never be a reason to.

### `GET /ready`

`200 { ready, store, geocoding }` only when the store is reachable, the queue can be read, and a geocoder is configured;
`503` with fixed words otherwise. It does **not** depend on an optional provider, Redis, the language model, or the queue
being full. For load balancers to route by.

### `GET /metrics` and `GET /ops/status` (operator)

`404` unless `OPS_TOKEN` is set; then they need `Authorization: Bearer <token>` (`401` otherwise; an address is locked out
after 10 wrong tokens in 15 minutes). `/metrics` is Prometheus text; `/ops/status` is a compact JSON view (store, queue
depth and capacity, Redis state, provider circuits, LLM, cache, telemetry, knowledge). Neither carries a secret, an address,
a person, a trip or anything a traveller wrote. See [observability.md](observability.md).

### `GET /v1/providers`

What is connected, what is not, and what a missing source would add. Also reports whether an LLM is
configured, and the data policy string the UI displays. Which environment variable would enable a missing
source, and why it is off, are returned only when `EXPOSE_PROVIDER_DETAILS` is on (the default outside
production): they describe the deployment.

### `GET /v1/providers/health`

Live probe of each connected provider. `207` if any is degraded. **Off in production** (`403`) unless
`EXPOSE_PROVIDER_HEALTH=true`, because some probes call billed APIs (Google Places and Routes make a real
request) and it says which providers are down. Limited to 5 a minute per address, and shared: everyone who
asks within thirty seconds gets the same round of probes.
