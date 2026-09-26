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

**Hard constraints are filters, not suggestions.** Dates, room count, accessibility needs and "no
overnight travel" remove options before anything is ranked, and every removal is recorded with its
reason. Nothing is quietly relaxed to make a plan fit a number.

**A budget is a guide, unless you say "do not exceed".** By default a plan over budget is still
shown, flagged and ranked lower, so you can see what a nicer stay costs. Say "do not exceed ₹80,000"
and it becomes a hard limit: what cannot fit is filtered, with the reason. Plans are ranked on the
journey and the stay together, so a hotel that suits you counts as much as a good flight.

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

**Pin what you like.** Tick the hotel, or say "make it cheaper but keep the hotel", and it is carried
over exactly while everything else is optimised again. Pins persist. When new dates or a different
group make a pinned part impossible to keep, you are told which part and why, not left believing it
was kept. Changes that would break something you set (new dates, a different group size, a comfort
upgrade over a firm budget) are explained and asked about before anything happens.

**Agents that understand you; code that decides.** Tell it what you want in your own words and a Requirements Agent reads it, quoting your words for everything it takes from them. Transport, stay and activity agents turn that into soft guidance; an orchestrator runs them, then the deterministic planner (every price, date, total and constraint is code), an independent validation gate, and a writer whose explanation is fact-checked against the plans, so it can only restate what the plan contains. Agents fill gaps and never overwrite your answers, cannot set a price, and cannot make a request you did not make. Without a language model configured, every agent falls back to plain rules and says so.

**Searches run in the background.** Searching many providers takes a while, so it never holds a
request open: you get a progress view you can leave and come back to, cancel, or reload without losing
anything. If a worker dies mid-search another picks it up, and results for a trip you changed
meanwhile are thrown away rather than shown against the wrong trip.

**Your trips are yours.** Planning needs no sign-up: you get a private session, and nobody else can open
your trips. Sign in with an emailed link (no password) to keep them across devices, and download or
delete everything from your account.

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
# set SESSION_SECRET (at least 32 characters) — compose refuses to start without it
docker compose up --build
```

Brings up PostgreSQL, Redis, the API, a separate search worker and the web app, running migrations
first. Sign-in by email needs `MAIL_WEBHOOK_URL`; without it the app says so and you keep planning
without signing in. Docker is not required for development: see below.

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
  agents/      The planning agents, deterministic services and the orchestrator
               that coordinates them. Agent output is untrusted and checked.
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
npm run dev:worker     # a search worker on its own (see RUN_WORKER in .env.example)
npm test               # all workspace tests (needs nothing installed or running)
npm run test:integration   # the store contract and request path against a real PostgreSQL
npm run smoke          # the built API + worker end to end on a throwaway PostgreSQL
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

Docker is optional. `npm run test:integration` and `npm run smoke` start a private PostgreSQL 16 from the
`embedded-postgres` dev dependency, apply the migrations to it, and remove it afterwards. To use a
database you run yourself, set `TEST_DATABASE_URL` to a disposable one whose name contains "test": the
integration tests empty its tables.

Migrations are additive and never edited once released; add a new one for each schema change.

---

## Booking

**Booking is not available in this release.** Wayfare plans, compares and adjusts trips; it cannot
reserve, pay for or ticket anything. Every booking endpoint answers `501 booking_unavailable`, stores
nothing, and does not collect traveller names or passport numbers.

The state machine for booking is kept in the code, with the rule that a client can never send a
payment or provider event, and idempotency that is atomic and per user. None of it is reachable over
HTTP yet, and it needs a payment provider, a booking-capable provider and encrypted traveller data
before it can be switched on. Accounts and ownership now exist, which it builds on.

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
