# Security

## Reporting a vulnerability

Please report privately, not in a public issue. Use GitHub's **Report a vulnerability** button under
the Security tab, or email the maintainers listed in the repository.

Include what you did, what happened, and what you expected. A proof of concept helps; a working
exploit is not required and we would rather you did not attach one.

We aim to acknowledge within three working days and to agree a disclosure timeline with you. We will
credit you unless you ask us not to.

---

## What this release is, and is not

This release **plans trips**. It searches providers, compares options and adjusts plans. It does not
book, pay for or ticket anything; every booking endpoint answers `501` and stores nothing (see
[docs/booking.md](docs/booking.md)). That removes the most dangerous surface, and it also means several
protections below are described as *not yet built* rather than assumed.

**It is not ready to run publicly for other people as it stands.** There is no authentication. Read
"Known limitations" before deploying it anywhere reachable from the internet.

## What this system handles

| Data | Sensitivity | Where it lives |
|---|---|---|
| Trip intent, preferences, itineraries | low to moderate: reveals when and where someone will be away | `trips.session` (JSON) |
| Free text the traveller types (a location preference, a change request) | moderate | the trip; change requests are also in the decision log |
| Provider API credentials | secret | environment only |
| Traveller names, dates of birth, passport numbers | sensitive | **not collected in this release** |
| Payment card data | — | **never handled**; there is no field for it |

---

## Controls in place

**Secrets** live only in the environment. `.env` is git-ignored, `.env.example` contains no real
values, and CI fails if a `.env` file is ever tracked or if gitleaks finds a credential anywhere in
history — a key that was committed and then removed is still a leaked key.

**Input validation** happens at the API boundary with Zod: request bodies, and every questionnaire
answer against the question as it was asked (options, limits, currency, applicability). A rejected
answer never reaches storage. Both stores validate a trip against the schema before writing it, and
the PostgreSQL store validates again when reading, so a malformed value cannot make a trip permanently
unreadable. Rail and bus provider responses are validated against a documented contract and discarded
if they do not match. **Amadeus and Google responses are typed but not schema-validated**; a change on
their side could produce odd values (see below).

**Language-model output is untrusted.** The only thing a model does is classify a change request. Its
parameters are checked field by field against domain rules and invalid ones are dropped and logged;
the engine validates the request again before applying it; the text shown to the traveller is written
from the validated request and never taken from the model; and the traveller's message is
JSON-escaped inside a delimited block with an instruction that it is data. Nothing a model says can
set a price, skip a hard constraint or become traveller-visible text. This reduces prompt injection; it
does not make it impossible, and the design depends on the model having so little authority that
manipulating it gains an attacker almost nothing. Model calls have a timeout (`LLM_TIMEOUT_MS`).

**Logging** redacts by path: `authorization` and `cookie` headers, `*.apiKey`, `*.clientSecret`,
`*.password`, `*.document` and `travelers[*].document`. That list does **not** cover names, email
addresses, phone numbers or dates of birth, which matters if traveller data is ever collected. Vendor
error bodies are never logged or returned verbatim. The public `/health` and `/ready` endpoints return
a fixed message when the database is down; the underlying error is logged, not returned.

**Transport hardening**: helmet, an explicit CORS allowlist (`CORS_ORIGINS`), a 1 MB body limit,
per-request timeouts on every outbound call, bounded retries with jittered backoff, and per-provider
request pacing. A search runs in the background and is bounded by `PLANNING_TIMEOUT_MS`; when it times
out or is cancelled, the provider calls it has in flight are aborted and it never retries them.

**Identity and sessions**: a trip belongs to the person who made it, and someone else's trip is
reported as "not found", exactly as one that does not exist, so ids cannot be probed. Everyone who plans
gets a private session in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production); the cookie is 256
random bits and only an HMAC of it, keyed with `SESSION_SECRET`, is stored, so a copy of the database
cannot be used to sign in. Signing in is by an emailed single-use link with a short life; the token is
exchanged by POST (so a mail scanner's prefetch cannot use it up), is consumed atomically (two requests
cannot both use it), and every sign-in issues a fresh session. The link is never returned by the API
(except as a development convenience with `MAILER=console`, which production refuses). A request that
changes something and names an `Origin` outside `CORS_ORIGINS` is refused. `GET /v1/me/export` and
`DELETE /v1/me` let a person take or erase their data; deletion removes their trips, runs, audit events and
sessions together.

**Cost controls**: each search calls paid provider APIs, so a person may start a limited number a day
(lower until they sign in), a trip can have at most one active search, the expensive routes have their
own tight rate limits, and the rate limiter keys on the person where there is one and on the client
address otherwise. `TRUST_PROXY` is off by default: `X-Forwarded-For` is only believed if the operator
says which proxies to trust.

**Data handling**: a provider's revalidation token (the key to re-pricing an offer) is stored with the
trip but blanked in every response except the owner's own export. Every store write is checked for the
version that was read (optimistic locking), so two changes cannot silently overwrite each other, and a
search's plans are only saved if the trip still has the inputs the search started with.

**Booking safeguards, kept for when booking returns**: the state machine, the rule that a client can
never send a payment or provider event, atomic per-user idempotency, and a state check so a transition
applies at most once. They are tested, and unreachable over HTTP today.

**Production refusals**: the service will not start in production without `SESSION_SECRET` (minimum 32
characters; `JWT_SECRET` is read as its old name) or without `DATABASE_URL`, and refuses `MAILER=console`.
Starting with the in-memory store in production would lose every trip on deploy, and a secret that is
public in the source would protect nothing.

**Containers** run as an unprivileged user and contain only production dependencies and compiled
output.

---

## Known limitations

These are real. Treat them as prerequisites before running this for other people.

- **Anonymous sessions are cheap to make.** Anyone can get a fresh session, and each has its own daily
  search allowance, so clearing cookies restarts the count. What bounds it is the per-address limit on
  creating a first trip (30 an hour) and the general per-address rate limit, both of which are only as
  good as `TRUST_PROXY`. An operator worried about their provider bill should also set provider-side
  quotas; there is no per-address daily cap on searches.
- **Rate-limit counters live in each API process.** With several API instances each counts separately,
  so the effective limit is the configured one times the number of instances. The daily search
  allowance is in the database and is exact.
- **Sign-in is an emailed link only.** There is no second factor, no session list or "sign out
  everywhere" endpoint (the store supports it), and no account recovery beyond a new link to the same
  address. Whoever controls the mailbox controls the account.
- **A trip with no owner is unreachable.** Rows created before accounts existed have no owner and cannot
  be opened by anyone; they are not migrated to anyone.
- **`/v1/providers/health` is public and calls billed APIs**, including a real Google Places request.
  It is limited to 5 a minute per caller, which bounds the cost but does not stop it.
  `/v1/providers` reveals which providers are missing and the names of the environment variables that
  would enable them. Restrict both.
- **A search that is cancelled or times out stops calling providers it has not reached yet and aborts
  the calls in flight, but a provider may already have counted a request it received.** A worker that
  is killed outright leaves its search to lapse (30 seconds by default) before another takes it up.
- **Provider responses from Amadeus and Google are not validated against a schema**, unlike rail and
  bus.
- **Free text is stored and shown back.** It is bounded and single-line, and rendered as text (not
  HTML), but any future feature that puts stored text into a prompt or a page must treat it as
  hostile.
- **Traveller documents are not encrypted by the application**, and nothing stores them in this
  release. The schema carries `encrypted` and `nonce` columns and the repository is shaped for it, but
  the implementation stores the serialised record. Implement encryption before booking is enabled.
- **The audit trail is thin.** Trip creation, consent answers, pin changes and search start/finish are
  recorded, and sign-ins are; reads are not. Trips are kept until deleted. Housekeeping (in each worker,
  every ten minutes) removes expired sessions, sign-in links, idempotency claims, finished runs older than
  a week and abandoned anonymous accounts.
- **Compose publishes PostgreSQL and Redis on the host** with a default password. It is a local
  development convenience; do not use it as a deployment.
- **Redis is not used** by the application. It runs in compose and `REDIS_URL` is accepted, for a caching
  and queueing phase that has not happened.
- **The PostgreSQL tests use a throwaway local server, not a managed one.** The store contract, the
  migrations and the request path run against real PostgreSQL 16 (embedded, or the CI service), which is
  what found that the original init migration could not apply. Behaviour under a managed provider's
  connection pooler, replicas or a different collation has not been tested.

---

## Reporting scope

In scope: authentication and authorisation flaws once they exist, injection, SSRF through provider
configuration, secret leakage, anything letting a client set a booking state a provider or payment
processor alone should set, idempotency bypasses, prompt-injection paths that change what a plan says
or does, and anything causing the system to present fabricated travel data as real.

Out of scope: the known limitations above (already documented), vulnerabilities in third-party
provider APIs, findings that require a malicious operator with environment access, and rate limiting on
a deployment that has disabled it.
