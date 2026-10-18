# Providers

Every piece of travel data in Wayfare comes from an adapter in `packages/providers`. Nothing else in
the system knows that Amadeus or OSRM exist, and nothing anywhere is allowed to substitute data a
provider did not return.

## The rules

Every adapter, including any you write, must hold to these. A third rule applies to money: **prices
are in INR, and nothing is converted.** A result in any other currency is set aside by the planner
with a note naming your provider (see `currency.ts`), so an adapter should request INR and should not
try to convert.

1. **Return a failure rather than partial or invented data.** If the provider timed out, said no, or
   is not configured, return a `ProviderFailure` with the right status. Never a plausible default,
   never a cached guess, never an empty success.
2. **Attach provenance to everything returned.** Which adapter, when it was retrieved, how long it
   stays valid, and any attribution the provider's terms require. This is displayed to travellers
   next to prices.
3. **Check what the provider sent before mapping it.** Every adapter validates the response against
   the fields it reads (`packages/providers/src/schemas.ts`) and reports a response that does not
   match as `invalid_response`, at the boundary, instead of letting a `TypeError` surface later or a
   plausible-looking wrong itinerary get built. One bad row in a list is dropped and counted in a
   warning; a list in which no row is usable is `invalid_response` as a whole.

```ts
type ProviderResult<T> = ProviderOk<T> | ProviderFailure;

interface ProviderOk<T> {
  status: 'ok';
  data: T;
  provenance: ProviderProvenance;   // provider, retrievedAt, validUntil, attribution
  warnings: string[];               // non-fatal, surfaced to the traveller
}

interface ProviderFailure {
  status: 'not_configured' | 'unavailable' | 'no_availability' | 'rate_limited'
        | 'timeout' | 'invalid_request' | 'invalid_response' | 'price_changed'
        | 'booking_unavailable' | 'unsupported_route' | 'unsupported_capability';
  provider: string;
  providerLabel: string;
  capability?: ProviderCapability;  // what was being asked for: flights, hotels, trains, ...
  message: string;                  // plain language, for a traveller, no stack traces
  retryAfterSeconds?: number;
  occurredAt: string;
}
```

### Five outcomes a traveller must be able to tell apart

The statuses collapse into the classes below (`statusClass()` in `@trip/shared`), which is what the
screen labels:

| Class | Statuses | Meaning |
|---|---|---|
| Not available | `not_configured`, `unsupported_capability` | This deployment has no such source. Not an error, and not "there are none". |
| Failed | `unavailable`, `invalid_request`, `price_changed`, `booking_unavailable` | The source is connected and did not do what was asked. |
| Timed out | `timeout` | It did not answer in time, or the search was stopped first. |
| Rate limited | `rate_limited` | It answered "slow down"; `retryAfterSeconds` says when to retry. |
| No results | `no_availability`, `unsupported_route` | It answered correctly and found nothing. |
| Unusable response | `invalid_response` | It answered with something that could not be read or trusted; none of it was used. |

The distinctions are what the traveller acts on: "connect a rail provider" is not "try again later" is
not "change your dates" is not "tell your provider its API changed".

## Notes are per capability

A vendor can serve more than one capability, and a missing or failing one is a different problem for each. Every
note the planner shows carries the `capability` it is about (`flights`, `hotels`, `trains`, `buses`,
`self_drive`, `transfers`, `activities`, `geocoding`), each capability's absence is worded for that
capability (`ProviderRegistry.missingCapabilityNote`), and notes are only merged when the provider,
capability, status and words all agree. Earlier, a missing Flights note and a missing Hotels note read
identically and were merged into one.

## One provider's bad day does not end the search

Everything the planner asks of a provider goes through `registry.policy` (`ProviderPolicy`, in
`packages/providers/src/guard.ts`). The default since Phase 5 is `ResilientPolicy`
(`packages/providers/src/policy.ts`; `IsolatingPolicy` remains for callers that want isolation only):

- turns anything a provider throws into a `ProviderFailure` (a mapping error on bad data is
  `invalid_response`, not "could not be reached");
- gives the call the smaller of its own ceiling (`PROVIDER_CALL_TIMEOUT_MS`, default 45 s) and what the
  stage of the search it belongs to has left, with a signal that fires on either that or cancellation, and
  which every HTTP request inside the call inherits (see [reliability.md](reliability.md));
- keeps a **circuit breaker** per provider and capability: after `PROVIDER_CIRCUIT_FAILURE_THRESHOLD`
  consecutive failures the provider is not called for `PROVIDER_CIRCUIT_RECOVERY_MS`, then one probe decides;
  a skipped call says so and repeats the last real failure;
- tags the failure with the capability being asked for, and marks failures caused by the planner's own limits
  (`local`: cancelled, out of stage time, request allowance spent) so they never count against a provider.

The engine asks every provider of one capability **at once** (`sweepProviders`), keeps what the ones that
answered returned, and keeps *one note per provider that failed* (it used to keep only the last). If
some options came back, the mode has results and a note about the source that did not answer; if none
did, the note that explains most wins (a source that broke outranks one that found nothing).

**Retries** are in `httpJson` (`packages/providers/src/http.ts`), where it is known that repeating is safe: only
GETs by default; only a network failure, a timeout, or a 408/500/502/503/504; never a 429 or another 4xx; bounded
by a count, a jittered exponential delay with a ceiling, the call's deadline and a per-host retry budget.
Redirects are followed only to the same origin and scheme (never for a POST), at most three, and never to an
address the SSRF rules refuse.

**Fallback** is for capabilities where one answer is wanted and several providers can give it: a drive is measured
by Google when it is connected and by OSRM when Google fails, and the answer names the provider that measured it
and what went wrong with the one before (`packages/providers/src/fallback.ts`). Search capabilities still ask
every provider and keep every answer.

**Caching** wraps the place lookup, routing and things-to-do providers (`cache.ts`): entries expire, are keyed by
every parameter, are checked against a schema on the way out, and are shared through Redis when it is configured.
Flights, hotels, rail and bus are never cached. Config: `CACHE_*`, `PROVIDER_*` in `.env.example`.

**Observed (Phase 7):** every provider call is a span and is counted (`provider_calls_total`, failures by class, latency,
retries, fallbacks, circuit transitions); see [observability.md](observability.md). **Not built:** per-provider daily quota
accounting, and any live verification of the above against a real provider.

---

## Shipped adapters

| id | Capabilities | Credentials | Cost |
|---|---|---|---|
| `nominatim` | geocoding | `NOMINATIM_USER_AGENT` | free, 1 req/s on the public instance |
| `duffel` | flights, airport reference data | `DUFFEL_ACCESS_TOKEN` (`DUFFEL_ENVIRONMENT`, default `test`) | free test mode |
| `amadeus` | hotels | `AMADEUS_CLIENT_ID`, `AMADEUS_CLIENT_SECRET` | free sandbox |
| `hotelbeds-hotels` | hotels (availability, rate re-check, descriptive content) | `HOTELBEDS_API_KEY`, `HOTELBEDS_SECRET` (or `HOTELBEDS_HOTELS_*`) | test account free, limited |
| `hotelbeds-activities` | bookable activities | same pair (or `HOTELBEDS_ACTIVITIES_*`) | test account free, limited |
| `hotelbeds-transfers` | priced airport-hotel transfers | same pair (or `HOTELBEDS_TRANSFERS_*`) | test account free, limited |
| `bus-estimate` | bus fare ESTIMATE (not a search) | `BUS_FARE_ESTIMATE` (+ routing) | free |
| `osrm` | routing | `OSRM_BASE_URL` | free, self-hostable |
| `osrm-transfer` | ground transfers | `OSRM_BASE_URL` + tariffs | free |
| `self-drive` | drive cost and duration | routing + `SELF_DRIVE_PROFILE` | free |
| `google-places` | activities with opening hours | `GOOGLE_MAPS_API_KEY` | billed |
| `google-routes` | traffic-aware routing | `GOOGLE_MAPS_API_KEY` | billed |
| `rail` | rail search | `RAIL_PROVIDER_URL` | your provider |
| `bus` | bus search | `BUS_PROVIDER_URL` | your provider |

### Notes on specific adapters

**Nominatim** is the only hard requirement: a journey cannot be classified as domestic or
international without resolving both places to a country. A result with no resolvable country or
timezone is discarded rather than patched up, because guessing it would silently decide the shape of
the whole trip. The public instance's usage policy (identifying User-Agent, one request per second)
is enforced in the adapter rather than left to the operator to remember.

**Duffel** (flights; `adapters/duffel.ts`) is read only: it searches (`POST /air/offer_requests`),
re-reads one offer (`GET /air/offers/{id}`) and looks up airports near a point
(`GET /places/suggestions`). It has no call that creates an order, a payment or a hold. See "Duffel
setup" below.

**Amadeus** now serves hotels only (flights moved to Duffel). In the test environment it returns real
but cached inventory. The adapter labels itself "Amadeus (test environment)" so the UI can say which
environment a price came from instead of implying live availability.

Hotel mapping states only what Amadeus states. `refundable` comes only from
`policies.refundable.cancellationRefund` (`REFUNDABLE_UP_TO_DEADLINE` is true, `NON_REFUNDABLE` is false,
anything else is unknown, and a rate whose refund deadline has passed is not refundable). Room capacity
(`maxOccupancy`) stays unknown, because `guests.adults` is the number the rate was priced for. The
search asks for guests **per room**, counts children as guests (child ages and rates are not
requested, and the traveller is told), and refuses more than nine per room. The status of those enum
values was written from Amadeus's reference and has not been confirmed against live sandbox
responses.

**Re-pricing** (`revalidateFlight`, `revalidateHotel`) takes only the provider's own token, exactly as
the search returned it, never an identifier from this system's records. It is not reachable while
booking is off.

**OSRM** gives real distance and duration and no fares. Transfer prices come only from an
operator-configured tariff (`GROUND_TRANSPORT_TARIFFS`, INR only), are flagged `priceIsEstimate`, and
state the tariff as their basis. With no tariff configured, the leg is shown with distance and time
and no price, and is listed as not included in the total, rather than a number nobody can justify. A
taxi carries four, so a larger party is priced as several cars (`vehicles` on the offer, named in the
basis), and the night multiplier is applied by the clock **where the ride happens** (`timezone` on the
request), not the clock of the machine the planner runs on.

**Self-drive** has a known fare of ₹0: nobody sells you a ticket for your own car. Fuel and wear are
itemised separately, as estimates with their basis, only when `SELF_DRIVE_PROFILE` (which must be INR)
makes them calculable; without it they are named as "not calculated", never as zero. Tolls and parking
have no source and are always named as not calculated. Mandatory rest is built into long drives — an
eight-hour estimate that assumes nobody stops is not a plan anyone can execute. Departure is read as
local time at the origin and arrival is reported in the destination's zone, whatever zone the server
runs in.

**Mail webhook** (sign-in links; `apps/api/src/auth/mailer.ts`). Not a travel provider, but the one other
external integration. `MAILER=webhook` posts `{type, to, subject, text, link}` as JSON to
`MAIL_WEBHOOK_URL` with an optional bearer token, and a delivery problem is one of three traveller-safe
errors that never echo the address, a response body or a status text: the hook did not answer in time
(10 s), could not be reached, or answered with a status (`answered 500`). **Redirects are refused**
(`redirect: 'manual'`), because the body carries a sign-in link and must go to the address the operator
configured and nowhere else. Tested against a stand-in `fetch`; not verified against a real mail service.

**Google Places** exists mainly for opening hours. Without them the scheduler has to treat every
activity as always-open, which is how itineraries end up sending people to a museum on its closing
day. A place with unpublished hours is scheduled with a visible "check before you go" note, never
assumed open.

---

## Writing a rail or bus adapter

Rail and bus inventory has no global open API. The operators that expose one — Indian Railways,
RedBus, Trainline, Deutsche Bahn — require a commercial agreement per deployment. Shipping an
adapter that cannot legally run would be worse than useless, so Wayfare instead speaks one small
documented HTTP contract. Point it at a service **you are authorised to use** and it becomes a real
provider.

```dotenv
RAIL_PROVIDER_URL=https://rail-adapter.internal.example.com
RAIL_PROVIDER_KEY=...                       # sent as: Authorization: Bearer <key>
RAIL_PROVIDER_LABEL=Indian Railways (via your adapter)
RAIL_PROVIDER_COVERAGE=IN                   # or `global`, or a comma-separated list
```

### Request

`POST {RAIL_PROVIDER_URL}/search/trains` (buses: `POST {BUS_PROVIDER_URL}/search/buses`)

```json
{
  "origin":      { "name": "Hyderabad", "countryCode": "IN", "lat": 17.385, "lon": 78.4867 },
  "destination": { "name": "Bengaluru", "countryCode": "IN", "lat": 12.9716, "lon": 77.5946 },
  "date": "2026-11-10",
  "passengers": { "adults": 2, "children": 0, "infants": 0 },
  "currency": "INR",
  "classCode": null,
  "limit": 20
}
```

Also implement `GET /health`, used by `/v1/providers/health`.

### Response

```json
{
  "services": [
    {
      "id": "12785",
      "currency": "INR",
      "transfers": 0,
      "legs": [
        {
          "operatorCode": "IR",
          "operatorName": "Indian Railways",
          "serviceNumber": "12785",
          "originName": "Kacheguda",
          "originCode": "KCG",
          "destinationName": "KSR Bengaluru",
          "destinationCode": "SBC",
          "departureAt": "2026-11-10T19:05:00+05:30",
          "arrivalAt": "2026-11-11T05:40:00+05:30",
          "durationMinutes": 635,
          "vehicleType": "Express"
        }
      ],
      "fares": [
        { "code": "SL",  "label": "Sleeper",       "priceMajor": 495,  "availability": 42, "refundable": true },
        { "code": "3A",  "label": "AC 3 Tier",     "priceMajor": 1310, "availability": 8,  "refundable": true },
        { "code": "2A",  "label": "AC 2 Tier",     "priceMajor": 1875, "availabilityLabel": "RAC 3" }
      ],
      "cancellationPolicy": "Free until 48h before departure.",
      "baggageSummary": "No fixed limit",
      "revalidationToken": "opaque-string"
    }
  ],
  "validUntil": "2026-09-20T12:30:00.000Z",
  "searchId": "abc123",
  "warnings": []
}
```

### Rules the contract enforces

**Timestamps must carry an offset.** A bare local time cannot be validated against connections or
check-in allowances. Responses without one are rejected.

**Fare classes are yours.** `code` and `label` pass through exactly as your operator names them.
Wayfare never normalises them into invented "first/second class" tiers, because a 3A berth and a
semi-sleeper seat are not points on one shared scale. Indian Railways classes, European fare
families and bus categories all pass through as-is.

**`availability` is a count; `availabilityLabel` is free text.** Use the label for things like
`RAC 3` or `WL 12` that are not integers. Omit both if your operator does not publish availability;
do not invent a number.

**A malformed response is a provider error, not a malformed itinerary.** Every service is validated
against this schema before anything downstream sees it. A service that does not match (a leg with no
offset, or one that arrives before it departs) is dropped and counted in a warning; if none match, the
search reports `invalid_response` — failing at the cause rather than somewhere far from it.

**Offer ids include the day** (`rail:2030-11-10:12785`), because a service number repeats every day.
Flight offer ids include the route and date too (`duffel-flight:HYD-BLR-2030-11-10:off_…`), so an outward
and a return search can never produce the same id.

---

## Hotelbeds (Hotels, Activities, Transfers)

One Hotelbeds APItude account, three APIs, **three capabilities**. Each has its own adapter
(`hotelbeds-hotels.ts`, `hotelbeds-activities.ts`, `hotelbeds-transfers.ts`), its own credentials resolution and its
own on/off switch; `hotelbeds-client.ts` holds only what they truly share (hosts and request signing). A capability is
connected only when *its* credentials resolve, is listed as disabled with its own reason when not, and a failure in one
is reported against that one. Official docs: <https://developer.hotelbeds.com/documentation/hotels/>,
<https://developer.hotelbeds.com/documentation/activities/>, <https://developer.hotelbeds.com/documentation/transfers/>.

**Variables** (all optional; unset means that API is off and the app still starts):

| Variable | Meaning |
|---|---|
| `HOTELBEDS_API_KEY`, `HOTELBEDS_SECRET` | the shared pair; must be set together |
| `HOTELBEDS_HOTELS_API_KEY` / `_SECRET`, `HOTELBEDS_ACTIVITIES_...`, `HOTELBEDS_TRANSFERS_...` | a pair for one API (Hotelbeds issues keys per API); wins over the shared pair |
| `HOTELBEDS_HOTELS_ENABLED`, `HOTELBEDS_ACTIVITIES_ENABLED`, `HOTELBEDS_TRANSFERS_ENABLED` | `false` switches one API off |
| `HOTELBEDS_ENV` | `test` (default, `api.test.hotelbeds.com`) or `live` (`api.hotelbeds.com`) |
| `HOTELBEDS_MIN_INTERVAL_MS` | smallest gap between requests (default 250) |

**Authentication** (documented): headers `Api-key` and `X-Signature`, where the signature is the hex SHA-256 of the key,
the secret and the current Unix time in seconds, concatenated; it is made fresh for each request.

**Test account.** Hotelbeds' evaluation keys use the test host and, per its documentation, are limited to 50 requests a
day (403 afterwards). Test data is not live inventory, and nothing here assumes an evaluation key sees live inventory.
Every result from the test host carries a warning saying so and a "(test account)" label.

**Currency (important).** Hotelbeds prices in the currency of *your contract*. This planner is INR only and never
converts, so hotels, activities and transfers quoted in anything else are kept as they are and set aside by the planner with
a note. Unless your contract is in INR, expect Hotelbeds results to be set aside; the adapters still prove the connection.

### Hotels
Availability `POST /hotel-api/1.0/hotels` (stay, occupancy, geolocation), re-check `POST /hotel-api/1.0/checkrates`
(by rate key; this is `revalidateHotel`), liveness `GET /hotel-api/1.0/status`. Static text is separate:
`GET /hotel-content-api/1.0/hotels` supplies description and address, cached for a day, best effort (a failure never
fails a search or changes a price). Mapping: `sellingRate` is used when sent (`hotelMandatory`), else `net`; a rate that
covers several rooms is divided to one room; taxes the provider marks as not included and gives an amount for are kept
as `payAtProperty` and added to the plan's accommodation cost; `NRF` is non-refundable, a `NOR` rate with stated
charges is refundable until the first charge date, anything else is not claimed; category `4EST`/`5LUX`/`H3_5` become
stars, others are unrated; a property without a position is left out. Results are spread from cheapest to dearest so
budget, standard and premium/luxury plans all have rooms to choose from. Not done: facilities (they come as codes needing
a second lookup, so no amenities are claimed), images, child ages (children are counted as adults, with a warning), and
booking.

### Activities
`POST /activity-api/3.0/activities/availability` with the trip's dates, travellers' ages (adults 30, children 8,
infants 1, because ages are not collected) and a `gps` filter at the destination centre. Returns real bookable products
with provider prices. What it does **not** claim: where an activity is (the availability answer has no coordinates, so each is
placed at the destination centre and says so), opening hours or start times (left unknown), and availability on one
particular day. The price is Hotelbeds' for the date range and is marked "not yet confirmed" (`priceIsEstimate`); the
day-specific Details/CheckRate call is **not implemented** because its request format could not be verified from the public
documentation. A Google Maps place is never assumed to be a bookable Hotelbeds activity.

### Transfers
`GET /transfer-api/1.0/availability/{language}/from/{fromType}/{fromCode}/to/{toType}/{toCode}/{outbound}/{adults}/{children}/{infants}`
(one way). It is **not** a taxi-on-demand API: it prices a transfer between places it knows by code. The planner uses it
only for airport (IATA) to a Hotelbeds hotel (ATLAS code = the hotel code from the Hotelbeds Hotel API) and back, so
it applies only when the chosen hotel is a Hotelbeds one. A quote replaces the routing *estimate* for that leg
(distance and time stay the routing's), is counted as quoted, not modelled, and is never mixed with an estimate; if the
quote is in another currency or no vehicle fits the party, the estimate stays and a note says why. Each leg is asked once
per search, so the same airport-hotel run in several plans is one request. The availability answer has no separate
re-price call at this stage, so a service's `rateKey` is carried as its token and no revalidation is claimed. GPS and
port/station locations are not used.

### Verification status
Written from Hotelbeds' public documentation and tested against synthetic fixtures only. The hotel availability/check-rate
shapes follow Hotelbeds' own workflow example, the activities and transfers shapes follow their availability pages; the
content call's exact fields, activity durations and transfer luggage fields were not confirmed and are read defensively
(an unknown unit or field becomes "not stated"). **No real Hotelbeds request has been made.** Run
`npm run live:check -- --searches` with your key to find out.

---

## Bus fare estimates (no live bus provider)

No approved bus inventory API is connected. `BUS_FARE_ESTIMATE` (JSON, INR only) lets the operator supply a fare model:
categories with `perKm`, `averageSpeedKmh` and `minimumFare`, an optional `baseFare`, an `assumedDepartureTime`, and
**`source` and `asOf`, which are required** and are shown to the traveller. The distance comes from the routing
provider. There is **no default**: without it, buses are reported as not searched. The offer names no operator, service or
seat availability, its departure time is the assumed one (said so), it has no revalidation token, and it is counted as
modelled cost. It applies to India only and is replaced by a real provider the moment `BUS_PROVIDER_URL` is set. The example
numbers in `.env.example` are illustrative, not a tariff.

## Local taxi and auto-rickshaw estimates

Distance and time come from Google Routes (traffic-aware, if configured) or OSRM. The fare comes only from the operator's
tariff (`GROUND_TRANSPORT_TARIFFS`, and `AUTO_RICKSHAW_TARIFFS` for autos, 3 seats each): base + per km + per minute, a
night multiplier by the local clock, and an optional `minimumFare`; optional `source` and `asOf` are shown with it. The
result is always an estimate ("Not a quote: actual fares vary by operator, traffic and time"). With no tariff the leg is
timed and listed as not priced, never ₹0. Travelling in your own car stays ₹0 fare, fuel and wear separate, tolls and
parking "not calculated". No ride-hailing or rental-car API is used.

## Qrail (trains): not implemented

Qrail's public developer pages list plans (Free: Train Between Stations, Train Schedule, PNR Status; Pro: Running Status,
Live Station; Business: Fare & Availability) and show the key placed in the URL path, but publish no endpoint paths,
parameters or response fields that could be checked (the pages that would hold them were empty to a non-logged-in
reader). Nothing was guessed, so there is no adapter and trains stay "not connected" unless you point
`RAIL_PROVIDER_URL` at a service implementing the documented surface-transport contract. To add Qrail, supply its
API reference from your account. Note for that work: the key is in the URL, so the adapter must keep the URL out of every
log and error (the HTTP layer includes the URL in its errors today). Schedules are not seat availability and fares need
the Business plan.

## Google Maps Platform

One key (`GOOGLE_MAPS_API_KEY`) serves both uses and is sent in the `X-Goog-Api-Key` header, never in a URL, a log or a
response. In Google Cloud Console enable **Places API (New)** (nearby search for things to do) and **Routes API**
(`computeRoutes`: distance, traffic-aware time). Both are billed and need a billing account on the project. Geocoding is
done by Nominatim, not Google. A place found by Google is a listing, never proof of room, ticket or price availability.
Docs: <https://developers.google.com/maps/documentation/places/web-service>, <https://developers.google.com/maps/documentation/routes>.

## Gemini

Gemini has no dedicated setting: the code reads `LLM_PROVIDER=openai`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` and
`LLM_LABEL`, so point them at Google's OpenAI-compatible endpoint
(`https://generativelanguage.googleapis.com/v1beta/openai`, key as a bearer token, model id from
<https://ai.google.dev/gemini-api/docs>). The model only interprets what a traveller types; prices, totals, currency and
availability never come from it. Without it the planner uses keyword rules. The request shape is tested against a stub; a
real Gemini request has not been made (`npm run live:check -- --llm`).

## Live checks

`npm run build && npm run live:check` runs read-only requests with whatever is in `.env` and prints PASS / FAIL / SKIPPED per
integration without printing any credential. `-- --searches` adds one real search each for Hotelbeds Hotels, Activities,
Transfers (counts against a test account's quota) and Google Places (billed); `-- --llm` adds one tiny model request.
It never books, pays or creates an order. A PASS is one successful call; it does not establish live inventory, prices or
account approvals.

---

## Duffel setup (flights)

1. Create an account at <https://app.duffel.com> and, under Developers > Access tokens, create a **test**
   token. It starts with `duffel_test_`.
2. Put it in the **repository root `.env`** (that file is git-ignored; `.env.example` is the committed
   template). Nothing else is needed for test mode:

   ```dotenv
   DUFFEL_ACCESS_TOKEN=duffel_test_...   # your token, entered locally
   DUFFEL_ENVIRONMENT=test               # test (default) or live
   DUFFEL_MIN_INTERVAL_MS=500            # optional: smallest gap between requests
   ```

3. Restart the API. The start-up log lists which providers are connected (and `/ops/status` does, when
   `OPS_TOKEN` is set); flights show as "Duffel (test mode)".

Rules the loader enforces (`config.ts`): with no token the adapter is simply off and the app still starts;
the token must start with `duffel_test_` or `duffel_live_`; `DUFFEL_ENVIRONMENT` must name the same mode
as the token, so a live token is never used by leaving a setting out and a test token is never passed off
as live. A start-up error names the setting and never repeats the token.

**Test offers are not live availability.** Duffel has one host (`https://api.duffel.com`); the token decides
the mode. In test mode, searches return offers from Duffel's own sandbox airline ("Duffel Airways", IATA
`ZZ`) with schedules and prices that do not describe real flights, and other airlines' sandboxes may be
unavailable. The adapter labels every offer "Duffel (test mode)" so a price is never shown as a live fare.
Live mode needs a live token, which Duffel issues after you complete their account and, for live
ordering, payment onboarding; this project does not order or pay and has never been run in live mode.

**Safe check of a token** (read only; spends no search and creates nothing). In Git Bash, with the token in
your shell environment:

```
curl -s -H "Authorization: Bearer $DUFFEL_ACCESS_TOKEN" -H "Duffel-Version: v2" -H "Accept: application/json" \
  "https://api.duffel.com/places/suggestions?query=hyd"
```

A JSON list of places means the token works; a 401 means it was refused. A flight search itself is
`POST /air/offer_requests`, which creates an offer request in your Duffel account (free in test mode).

**Limits and unverified points**

- Duffel returns each offer in the airline's own currency. This planner is INR only: a non-INR offer is
  kept as it is and the engine sets it aside with an explanation; nothing is converted.
- Duffel has no carrier or price filter on a search, so preferred/excluded carriers and a price ceiling are
  applied after the search. With no stop limit set, Duffel's own default (one connection) applies.
- The default pacing (`DUFFEL_MIN_INTERVAL_MS=500`) is a conservative guess; Duffel documents per-token
  rate limits and answers `429`, which the planner reports as "rate limited" and does not retry. Check the
  limits for your account at <https://duffel.com/docs/api>.
- The nearest-airport lookup passes a radius in metres to `/places/suggestions`; the docs do not state a
  maximum radius, and this has not been run against the service.
- `Duffel-Version: v2` is the current version in Duffel's versioning page at the time of writing.
- Fixtures under `__tests__/fixtures/duffel` are synthetic, not recordings.

Run the flight-provider tests (no credentials, no network):

```
npm run build
npm test -w @trip/providers -- duffel-flights
# or all provider tests
npm test -w @trip/providers
```

---

## Testing an adapter without a network

`packages/providers/src/__tests__/adapter-contracts.test.ts` holds every adapter to the same table of
outcomes, served from JSON in `__tests__/fixtures` by a stand-in for `fetch` that fails the test on any
address it was not told about, so the suite cannot depend on a live service: success; nothing found;
refused credentials; rate limited (with `Retry-After`); a server error; a call that never answers; a
connection that fails; a body that is not JSON; JSON of the wrong shape; and an answer that is good
except for one row.

**The fixtures are hand-written from each vendor's public documentation. They are not recordings of live
responses**, because this repository never uses live credentials. They prove the adapters map the
documented shape and fail safely on everything else; they do not prove a vendor still answers in that
shape (see `fixtures/README.md`). To record real ones, someone with credentials replaces a file, keeps
its name, and the same tests report whether the adapter still maps it.

## Writing a new adapter from scratch

1. Implement the relevant interface from `packages/providers/src/types.ts` — `FlightProvider`,
   `HotelProvider`, `RailProvider`, `BusProvider`, `RoutingProvider`, `GroundTransportProvider`,
   `ActivityProvider`, `CarRentalProvider` or `GeocodingProvider`.
2. Declare a `ProviderDescriptor`: id, label, capabilities, required env vars, coverage, docs URL,
   and any attribution the provider's terms require.
3. Use `httpJson` from `packages/providers/src/http.ts` — it gives you a hard timeout, bounded
   retries with jittered backoff, and `RequestPacer` for vendors with rate limits. It hands back
   `unknown` for you to check, not a type you have to trust.
4. Describe the response with a Zod schema in `schemas.ts` and read it with `readResponse` /
   `readItems`; map errors with `toProviderFailure`. Vendor error bodies never reach a traveller
   verbatim; they routinely leak internal identifiers and unhelpful jargon.
5. Register it in `packages/providers/src/registry.ts`, including the `disable(...)` branch that
   explains what the adapter would add when its credentials are absent. That message is shown in the
   UI, so write it for a traveller.
6. Add it to `.env.example` and to the table in `README.md`.

`isConfigured()` returning false must be cheap and side-effect free: the registry calls it to decide
whether to skip the adapter entirely rather than burn a rate-limit slot returning nothing.
