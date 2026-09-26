# Contributing

Thanks for considering it. This document is short because most of what matters is in
[docs/architecture.md](docs/architecture.md); what follows is the part that is easy to get wrong.

## Getting set up

```bash
npm install
cp .env.example .env         # set NOMINATIM_USER_AGENT at minimum
npm run build
npm test
npm run dev
```

Node 22+. No database needed for local work — without `DATABASE_URL` trips are held in memory.

## The rules that are not negotiable

These exist because breaking them turns a planning tool into one that lies to travellers.

**1. Never fabricate travel data.** No sample inventory, no estimated prices standing in for real
ones, no "reasonable default" schedules. If a provider cannot answer, return a `ProviderFailure`
with the right status and let it reach the UI. `not_configured` and `no_availability` are different
answers and must stay different.

**2. A modelled figure must announce itself.** If you compute a cost from configuration rather than
receiving it from a provider, set `costIsEstimate`, give it an `estimateBasis` naming the config it
came from, and make sure it lands in `cost.estimatedPortion`. The UI reserves one colour for this
and uses it for nothing else.

**3. `null` means "the provider did not say".** It is not zero and not false. A fare with unstated
baggage is kept with the gap recorded; a fare that states too few bags is dropped with that reason.
Collapsing the two hides real options or invents guarantees.

**4. Hard constraints filter; soft preferences weight.** If you are adding something a traveller
stated as a requirement, it belongs in `applyHardConstraints` with a recorded reason for each drop —
not as a scoring penalty. If you are adding something that only nudges, it belongs in scoring.

**5. The model may not source facts.** `LlmProvider` has one method and it returns schema-validated
structured output. Do not add a free-text completion method. Do not let a model produce a price, a
schedule, a service number or an availability.

**6. Treat model output as untrusted input.** Anything a model returns, including what a keyword
fallback returns in its place, passes the same domain validation a form would (see
`sanitizeModificationParameters`) before it touches a trip, and text shown to a traveller is written
from validated data, never taken from a model. A new field a model may fill needs its own rule and a
test that feeds it hostile values.

**7. Unknown is not zero, and there is one currency.** A cost nobody can price goes in
`cost.notIncluded`, not into the total as ₹0. Everything is INR; do not compare, add or convert
amounts in another currency, and do not invent an exchange rate.

**8. Deterministic validation has the last word.** Anything that decides whether an itinerary is
physically possible goes in `validate.ts`, as arithmetic over instants and constraints.

## Code conventions

- **Money** is integer minor units via the `Money` helpers. Never a float, never a bare number.
- **Time** is a UTC instant plus the IANA zone it happens in. Never a bare local string.
- **Validation** at every boundary with Zod, including responses you read back from a database.
- **Comments** explain why, not what. The codebase has a lot of load-bearing decisions; a comment
  that records the reasoning behind one is worth more than three that narrate the code.
- Prose in the UI and in error messages is written for a traveller, not an operator. "No rail
  provider is connected" beats "RAIL_PROVIDER_URL unset".

## Tests

Run `npm test`; it needs nothing installed or running. `npm run test:integration` runs the store
contract and the request path against a real PostgreSQL (started for you, no Docker), and `npm run
smoke` drives the built API and worker end to end. Anything that touches storage belongs in the store
contract (`apps/api/src/__tests__/support/store-contract.ts`), which runs against both the in-memory
store and PostgreSQL; a schema change needs a new, additive migration and must keep them passing. New
behaviour needs a test; the ones worth writing here assert a *guarantee* rather than an implementation:

- that a confirmed booking is unreachable without a provider reference
- that a skipped question leaves no preference behind
- that an excluded mode carries a reason
- that a DST boundary does not shift an itinerary
- that a trip is not reachable by anyone but its owner
- that a search for a trip that changed meanwhile is discarded, not shown

`packages/engine/src/__tests__/fixtures.ts` has real places with real coordinates and timezones. Use
them rather than inventing convenient geography.

## Adding a provider

See [docs/providers.md](docs/providers.md). In short: implement the interface, declare a descriptor,
use the shared `httpJson` client, map errors through `toProviderFailure`, register it including the
`disable(...)` branch that explains what it would add, and document it in `.env.example` and the
README table.

If you are connecting a commercial rail or bus API, use the documented HTTP contract rather than
adding a vendor SDK to this repository — it keeps the project usable by people who are not party to
your agreement.

## Pull requests

- One concern per PR.
- Say what a reviewer should check by hand, especially anything touching provider calls.
- `npm run lint && npm run typecheck && npm test && npm run build` should pass before you open it. CI
  runs the same plus the PostgreSQL integration tests and smoke run, a secret scan and a dependency audit. Do not silence a lint rule or a type
  error to make it pass; fix the cause.
- Never commit a filled-in `.env`. CI fails the build if one is tracked.

## Reporting security issues

Privately — see [SECURITY.md](SECURITY.md). Not in a public issue.
