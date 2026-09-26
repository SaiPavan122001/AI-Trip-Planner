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
request pacing. The API stops waiting for a planning request after `PLANNING_TIMEOUT_MS`, but that
does **not** cancel the work already in flight (see below).

**Booking safeguards, kept for when booking returns**: the state machine, the rule that a client can
never send a payment or provider event, atomic per-user idempotency, and a state check so a transition
applies at most once. They are tested, and unreachable over HTTP today.

**Production refusals**: the service will not start in production without `JWT_SECRET` (minimum 32
characters) or without `DATABASE_URL`. Starting with the in-memory store in production would lose every
trip on deploy. `JWT_SECRET` is **required but not yet used**: it is reserved for the authentication
that does not exist, and setting it protects nothing today.

**Containers** run as an unprivileged user and contain only production dependencies and compiled
output.

---

## Known limitations

These are real. Treat them as prerequisites before running this for other people.

- **There is no authentication or authorisation.** A trip's id is a random UUID and is the only thing
  protecting it: anyone who has the link can read, change and delete the trip. `X-User-Id` is a label
  the client chooses and is trusted as given, so `GET /v1/trips` with no header lists **every anonymous
  trip**. Put an authenticating gateway in front, or wait for the identity phase.
- **The rate limit can be bypassed.** It is keyed by the client-supplied `X-User-Id` header (or IP),
  and the server trusts `X-Forwarded-For` from anyone (`trustProxy: true`). Planning fans out to paid
  provider APIs, so an attacker can run up the operator's bill. Configure the trusted proxy
  deliberately once the deployment topology is known.
- **`/v1/providers/health` is public and calls billed APIs**, including a real Google Places request.
  `/v1/providers` reveals which providers are missing and the names of the environment variables that
  would enable them. Restrict both.
- **Planning is not cancellable.** After `PLANNING_TIMEOUT_MS` the client gets an error, but the search
  keeps running and spending provider quota, and may still save its result afterwards. There is no
  queue, cache or per-user cost cap.
- **Trips are read-modify-written without locking**, so two concurrent changes to the same trip can
  overwrite each other.
- **Provider responses from Amadeus and Google are not validated against a schema**, unlike rail and
  bus.
- **Free text is stored and shown back.** It is bounded and single-line, and rendered as text (not
  HTML), but any future feature that puts stored text into a prompt or a page must treat it as
  hostile.
- **Traveller documents are not encrypted by the application**, and nothing stores them in this
  release. The schema carries `encrypted` and `nonce` columns and the repository is shaped for it, but
  the implementation stores the serialised record. Implement encryption before booking is enabled.
- **`audit_events` is never written**, and `users` is never used. There is no record of who viewed or
  changed a trip, and no retention job: trips are kept until deleted, and expired idempotency claims
  are never swept from the table.
- **Compose publishes PostgreSQL and Redis on the host** with a default password. It is a local
  development convenience; do not use it as a deployment.
- **Redis is not used** by the application. It runs in compose and `REDIS_URL` is accepted, for a caching
  and queueing phase that has not happened.
- **Concurrency and idempotency were tested against an in-memory store and a fake client**, not a live
  PostgreSQL. No Postgres integration test has been run.

---

## Reporting scope

In scope: authentication and authorisation flaws once they exist, injection, SSRF through provider
configuration, secret leakage, anything letting a client set a booking state a provider or payment
processor alone should set, idempotency bypasses, prompt-injection paths that change what a plan says
or does, and anything causing the system to present fabricated travel data as real.

Out of scope: the known limitations above (already documented), vulnerabilities in third-party
provider APIs, findings that require a malicious operator with environment access, and rate limiting on
a deployment that has disabled it.
