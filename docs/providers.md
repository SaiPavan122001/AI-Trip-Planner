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

Amadeus serves both flights and hotels, so a missing or failing Amadeus is two different problems. Every
note the planner shows carries the `capability` it is about (`flights`, `hotels`, `trains`, `buses`,
`self_drive`, `transfers`, `activities`, `geocoding`), each capability's absence is worded for that
capability (`ProviderRegistry.missingCapabilityNote`), and notes are only merged when the provider,
capability, status and words all agree. Earlier, a missing Flights note and a missing Hotels note read
identically and were merged into one.

## One provider's bad day does not end the search

Everything the planner asks of a provider goes through `registry.policy` (`ProviderPolicy`, in
`packages/providers/src/guard.ts`). The default, `IsolatingPolicy`:

- turns anything a provider throws into a `ProviderFailure` (a mapping error on bad data is
  `invalid_response`, not "could not be reached");
- puts a deadline on the call (`PROVIDER_CALL_TIMEOUT_MS`, default 45 s) on top of the adapter's own
  timeouts, and reports a call that has not answered as `timeout`;
- tags the failure with the capability being asked for.

The engine asks every provider of one capability **at once** (`sweepProviders`), keeps what the ones that
answered returned, and keeps *one note per provider that failed* (it used to keep only the last). If
some options came back, the mode has results and a note about the source that did not answer; if none
did, the note that explains most wins (a source that broke outranks one that found nothing).

**What this does not do, and where it goes.** No retry beyond `httpJson`'s bounded transient retries, no
fallback from one provider to another, no shared rate limiter, no circuit breaker, no response cache, no
metrics or tracing. Each is a different `ProviderPolicy` handed to `new ProviderRegistry(env, policy)`;
nothing that calls a provider needs to change. They are later-phase work, and they are not claimed here.

---

## Shipped adapters

| id | Capabilities | Credentials | Cost |
|---|---|---|---|
| `nominatim` | geocoding | `NOMINATIM_USER_AGENT` | free, 1 req/s on the public instance |
| `amadeus` | flights, hotels, airport reference data | `AMADEUS_CLIENT_ID`, `AMADEUS_CLIENT_SECRET` | free sandbox |
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

**Amadeus** in the test environment returns real but cached inventory. The adapter labels itself
"Amadeus (test environment)" so the UI can say which environment a price came from instead of
implying live availability. Flight re-pricing carries the full offer payload as its revalidation
token, because that is the only input the pricing endpoint accepts.

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
Amadeus numbers its offers within each response, so its ids include the route and date too
(`amadeus-flight:HYD-BLR-2030-11-10:1`); the outward and return searches would otherwise both produce
`…:1`.

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
