# Wayfare

An open-source trip planner that treats planning as a constraint problem rather than a search box.

Tell it where you are going and what actually matters to you. It works out whether this is a flight
problem or a train problem, searches the providers you have connected, and builds the entire
journey — transfers, check-in allowances, opening hours, the hour you lose at the airport — then
tells you what the whole thing costs.

**It never invents travel data.** Every price, schedule and availability comes from a connected
provider and is labelled with its source and retrieval time. Where a provider is missing or
unavailable, the planner says so. There is no sample inventory and no fallback to plausible-looking
numbers.

---

## What makes it different

**The journey decides the options.** Hyderabad to Warangal and Hyderabad to Paris are different
problems. Classification runs before any question about budget, and it names the modes it ruled out
along with the reason — so "no trains" is an answer, not an omission.

**Questions that change the answer.** One at a time, chosen from what is already known. A solo
business traveller is never asked about cots. Nobody is asked about rail classes on a route with no
rail.

**Hard constraints are filters, not suggestions.** Budget, dates, room count, accessibility needs
and "no overnight travel" remove options before anything is ranked, and every removal is recorded
with its reason. Nothing is quietly relaxed to make a plan fit a number.

**Total cost, not sticker price.** A room ₹1,000 cheaper that adds ₹2,500 a day in taxis is priced
with the taxis. Accommodation is chosen on what the whole stay costs.

**Modelled figures are visibly modelled.** Taxi fares from a configured tariff and meals from your
stated daily allowance are real estimates, labelled as estimates, with the basis stated and totalled
separately from quoted prices.

**The model routes; it does not source.** The LLM classifies what you typed when you ask for a
change. It never produces a price, a schedule, a flight number or an availability, and what it returns
is treated as untrusted: every value is checked against the same rules a form would apply, invalid
ones are dropped, and the sentence shown to you is written from the validated request, never taken
from the model. Every plan is validated afterwards by deterministic rules that cannot be argued
with.

**Pin what you like.** Say "make it cheaper but keep the hotel" and the hotel is carried over exactly,
with the date its price was retrieved, while everything else is optimised again. When a change
would break something you set (a comfort upgrade over your budget, new dates, a different group
size), you are told what will change and asked before anything does.

**Indian rupees only.** Wayfare serves travellers in India, so every budget and price is in INR.
Prices a provider returns in another currency are set aside with a reason; nothing is converted at an
invented rate.

---

## Quick start

Requires Node 22+.

```bash
git clone <your-fork> wayfare && cd wayfare
npm install
cp .env.example .env
```

Open `.env` and set one thing to get going:

```dotenv
NOMINATIM_USER_AGENT=wayfare-dev (you@example.com)
```

That is enough to resolve places and classify a journey. Then:

```bash
npm run build          # compile the workspace packages
npm run dev            # API on :4000, web on :3000
```

Open <http://localhost:3000>.

With nothing else configured you will get a complete interview, a correct journey classification, and
an honest report that no flight, rail, bus or hotel provider is connected. That is the intended
zero-credential experience — see [Connecting providers](#connecting-providers) to widen it.

### With Docker

```bash
cp .env.example .env
# set JWT_SECRET — compose refuses to start without it (it is reserved for
# authentication, which is not implemented yet, so nothing reads it today)
docker compose up --build
```

Brings up PostgreSQL, Redis, the API and the web app, running migrations first.

---

## Connecting providers

Every adapter is optional and independently switchable. Set the variables, restart, and the
capability appears; leave them unset and the UI tells travellers which source is missing and what it
would add.

| Capability | Adapter | Variables | Notes |
|---|---|---|---|
| Place lookup | OpenStreetMap Nominatim | `NOMINATIM_USER_AGENT` | Free. Required — a journey cannot be classified without resolving both places to a country. Public instance allows 1 req/s. |
| Flights, hotels | Amadeus Self-Service | `AMADEUS_CLIENT_ID`, `AMADEUS_CLIENT_SECRET` | Free sandbox. Test-environment prices are labelled as such. |
| Routing, transfers, self-drive | OSRM | `OSRM_BASE_URL` | Free. Real distance and duration; fares come from your tariff config. |
| Things to do, traffic-aware transfers | Google Maps Platform | `GOOGLE_MAPS_API_KEY` | Billed. Brings published opening hours. |
| Rail | Your authorised provider | `RAIL_PROVIDER_URL` | No global open API exists. Implement the documented contract. |
| Bus | Your authorised provider | `BUS_PROVIDER_URL` | Same. |
| Language understanding | Anthropic, or any OpenAI-compatible endpoint | `ANTHROPIC_API_KEY`, or `LLM_BASE_URL` + `LLM_MODEL` | Optional. Without it, plain-language changes use keyword rules. |

Rail and bus have no global open API, and the operators that do expose one require a commercial
agreement per deployment. Rather than ship an adapter that cannot legally run, Wayfare speaks one
small documented HTTP contract: point it at a service you are authorised to use and it becomes a
real provider. See [docs/providers.md](docs/providers.md).

Check what is live at any time:

```bash
curl localhost:4000/v1/providers        # what is connected, what is not, and why
curl localhost:4000/v1/providers/health # live probe of each one
```

---

## Layout

```
packages/
  shared/      Domain model and Zod schemas. Money, places, constraints,
               offers, itineraries, the booking state machine.
  providers/   Provider interfaces and adapters. The only code that knows
               about vendor APIs.
  engine/      The planner. Classification, questioning, scoring, search
               orchestration, scheduling, costing, validation.
  llm/         Pluggable LLM boundary with a deterministic fallback.
apps/
  api/         Fastify service, Prisma persistence, booking state machine.
  web/         Next.js front end.
docs/          Architecture, provider contract, API reference, security.
```

The dependency direction is one-way: `shared` ← `providers` ← `engine` ← `api` ← `web`. Nothing in
the engine imports a vendor SDK; nothing in the UI decides what to ask next.

---

## Development

```bash
npm run dev            # API and web together
npm run dev:api        # API only
npm run dev:web        # web only
npm test               # all workspace tests
npm run lint           # ESLint, all workspaces
npm run typecheck      # all workspaces
npm run build          # full build in dependency order
```

### Database

Without `DATABASE_URL`, trips are held in memory and lost on restart — fine for local work, and the
API refuses to start in production without it.

```bash
docker compose up -d postgres
export DATABASE_URL=postgresql://wayfare:wayfare@localhost:5432/wayfare
npm run db:generate    # Prisma client
npm run db:migrate     # apply migrations
```

---

## Booking

**Booking is not available in this release.** Wayfare plans, compares and adjusts trips; it cannot
reserve, pay for or ticket anything. Every booking endpoint answers `501 booking_unavailable`, stores
nothing, and does not collect traveller names or passport numbers.

The state machine for booking is kept in the code, with the rule that a client can never send a
payment or provider event, and idempotency that is atomic and per user. None of it is reachable over
HTTP yet, and it needs a payment provider, a booking-capable provider, authentication and encrypted
traveller data before it can be switched on.

See [docs/booking.md](docs/booking.md).

---

## Documentation

- [Architecture](docs/architecture.md) — the pipeline, the decision model, why the AI sits where it does
- [Providers](docs/providers.md) — the interfaces, and the contract for your own rail or bus adapter
- [API reference](docs/api.md) — every endpoint, with request and response shapes
- [Booking](docs/booking.md) — the state machine and its guarantees
- [Security](SECURITY.md) — threat model, data handling, reporting a vulnerability
- [Contributing](CONTRIBUTING.md)

---

## Licence

Apache 2.0. See [LICENSE](LICENSE).

Attribution required by connected providers is displayed in the UI and returned by
`GET /v1/providers`. Using this software with a provider API makes you responsible for that
provider's terms.
