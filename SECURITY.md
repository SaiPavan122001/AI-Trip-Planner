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

People use it with a private session (an `HttpOnly` cookie) from the moment they plan, and can sign in by an
emailed link to keep their trips across devices. Phase 6 audited the code against the threat model in
[docs/threat-model.md](docs/threat-model.md) and fixed what it found; **that is an audit by the people who wrote
the code, not an independent penetration test**, and nothing here has been run against live providers, a real
Redis, a managed database or a real mail service. Read "Known limitations" before deploying it anywhere
reachable from the internet, and put the usual perimeter (TLS, a CDN or WAF for volumetric attacks) in front.

## What this system handles

| Data | Sensitivity | Where it lives |
|---|---|---|
| Trip intent, preferences, itineraries | low to moderate: reveals when and where someone will be away | `trips.session` (JSON) |
| Free text the traveller types (a location preference, a change request) | moderate | the trip; change requests are also in the decision log |
| Email address (only for someone who signed in) | personal data | `users.email`; never copied into a trip, run or audit event |
| Provider API credentials, `SESSION_SECRET`, mail webhook token | secret | environment only |
| A caller's address | personal data | **never stored**: only a keyed hash, in memory or Redis, for the length of a rate-limit window, and in security log lines |
| Curated knowledge documents (policies, rules, guides) and their vectors | public content, but a poisoned one misleads | `knowledge_documents`, `knowledge_chunks`; **shared, and holds nothing about a traveller** (no owner, user, trip or email field exists) |
| Telemetry: logs, metrics, traces | must carry no secret and no traveller's words | stdout, `/metrics` (token), the operator's OTLP collector; ids are in logs and traces, never in metric labels |
| Traveller names, dates of birth, passport numbers | sensitive | **not collected in this release** |
| Payment card data | — | **never handled**; there is no field for it |

Retention: trips and their searches are kept until the person deletes them (or their account); an abandoned
anonymous account with nothing in it, expired sessions and links, idempotency answers (24 h) and finished
searches (a week) are swept every ten minutes. There is no automatic expiry of a signed-in person's trips: that
is a product decision, listed in `DECISIONS.md`.

---

## Controls in place

**Secrets** live only in the environment. `.env` is git-ignored, `.env.example` holds no values for any key,
secret, token or password (a test checks), and CI fails if a `.env` file is ever tracked or if gitleaks finds a
credential anywhere in history. Phase 6 also scanned the tracked files and the whole of git history for
credential patterns (AWS, Google, provider secret keys, Slack and GitHub tokens, private keys, connection
strings with passwords): none, apart from the documented local development database login. Start-up refuses
configuration that could leak or be steered: a base URL or webhook that is not plain http(s), that carries
credentials, or is not https in production (unless it names the operator's own network); a malformed
`CORS_ORIGINS`. Configuration errors name the setting and never repeat its value.

**Input validation** happens at the API boundary with Zod: request bodies (strict: a field nobody asked for is an
error, not something quietly assigned), query and path parameters (ids are UUIDs), and every questionnaire
answer against the question as it was asked. Every string has a maximum; bodies are limited to 64 KB
(`MAX_BODY_BYTES`) and refused before they are parsed; only `application/json` is read; free text from a person
has hidden characters (control characters, zero-width and direction-override characters, the invisible Unicode
"tag" block) removed before it is stored. A rejected answer never reaches storage. Both stores validate a trip
against the schema before writing it, and the PostgreSQL store validates again when reading. **Every provider
response** is validated against a schema before it is mapped; a body that does not match, or is not JSON, is
reported as `invalid_response` and discarded, and one bad row in a list is dropped without discarding its
neighbours. Anything a provider's adapter throws becomes a failure for that provider.

**Language-model output is untrusted, and so is what goes into a model.** Four kinds of thing are kept apart:
instructions (written by us, containing nothing a person wrote), application state, what the traveller wrote,
and what providers supplied. The last two go to a model only as JSON inside a tag the instructions name as
data; since Phase 6 `<`, `>` and `&` are escaped inside that block (plain JSON escaping does not escape `<`, so
text could close its own tag) and hidden characters are removed. The model has no tools. Its output is parsed
into a closed set of intents, every parameter is checked field by field against domain rules (a name it offers
must be one the traveller actually wrote), the engine validates the request again, and the text shown to the
traveller is written from the validated request and never taken from the model. Ownership, consent, pins and
budget rules are applied in code and the owner is checked *before* a model is asked, so a model that has been
persuaded of anything can affect nothing outside what a form could. This reduces prompt injection; it does not
make it impossible, and the design depends on the model having so little authority that persuading it gains
an attacker almost nothing. Model calls have a timeout (`LLM_TIMEOUT_MS`, `AGENT_TIMEOUT_MS`) and a circuit
breaker, and the OpenAI-compatible adapter refuses redirects.

**Identity and sessions**: a trip belongs to the person who made it, and someone else's trip is reported as "not
found", exactly as one that does not exist, so ids cannot be probed; a test walks every trip route as a
stranger and as no one (`authorization.test.ts`). The session cookie is 256 random bits in an `HttpOnly`,
`SameSite=Lax` (`Secure` in production) cookie; only an HMAC of it, keyed with `SESSION_SECRET`, is stored, so a
copy of the database cannot be used to sign in. A session ends `SESSION_MAX_DAYS` (90) after it began however
often it was used, can be ended on every device (`POST /v1/auth/logout-all`), and every sign-in issues a fresh
one. Signing in is by an emailed single-use link with a short life; the token is exchanged by POST (a mail
scanner's prefetch cannot use it up), consumed atomically, and answers identically whatever was wrong with it. A
run of refused links locks an address out (8 in 15 minutes), so guessing costs the service nothing. The link
request answers the same for known and unknown addresses. `GET /v1/me/export` and `DELETE /v1/me` let a person
take or erase their data.

**Cross-site requests**: only JSON bodies are read (a cross-site form or `text/plain` post cannot reach a route);
a request that changes something and names an `Origin` outside `CORS_ORIGINS` is refused; so is one that names
no `Origin` but is marked `Sec-Fetch-Site: cross-site`; the cookie is `SameSite=Lax`.

**Abuse and cost controls**: every request is counted per person **and per address**, so clearing cookies does
not restart a limit; expensive routes have named policies (searches, changes, reading words, place lookups,
sign-in emails per person, address, day and recipient, account export); anonymous searches are also capped per
address per day; a person may have only a few searches running; the queue is bounded (`503 busy` with
`Retry-After`, nothing queued to fail later) and stale queued searches are dropped; a search has a deadline and a
ceiling on provider requests. Counters are in Redis when configured (shared across instances) and fall back to
each process's memory when it is not answering, never to "unlimited". `TRUST_PROXY` is off by default: an
`X-Forwarded-For` header is only believed if the operator says which proxies to trust. See
[docs/reliability.md](docs/reliability.md).

**Outbound requests (SSRF)**: no API input is used as a URL or host. Redirects from a provider are followed only
to the same origin and scheme (never for a POST), at most three, and never to an address the guard refuses; the
guard (`packages/providers/src/ssrf.ts`) blocks non-http(s) schemes, credentials in URLs, loopback, private,
link-local (including cloud metadata), carrier-grade NAT, multicast and reserved addresses in every spelling
(decimal, hex, octal, IPv4-mapped IPv6, NAT64, 6to4), and names that resolve to them. An operator may point a
provider at their own network; that is allowed for URLs the operator wrote and refused for anything derived from
a response. Every outbound call has a timeout, a retry budget and a size limit on what is read. The mail
webhook refuses redirects (its body carries a sign-in link).

**Web application**: React escapes everything it renders; the source has no `dangerouslySetInnerHTML`,
`innerHTML`, `eval` or `document.write` (a test searches for them); the one link built from API data is checked
to be http(s). Every page carries a content security policy (own scripts, connections only to this site and the
configured API, no framing, no plugins, no changing where forms post), `X-Content-Type-Options`,
`Referrer-Policy`, `X-Frame-Options`, `Cross-Origin-Opener-Policy`, `Permissions-Policy` (no camera, microphone,
location or payment) and, in production, HSTS. The policy allows inline scripts because Next.js inlines its own;
a per-request nonce would tighten that. The API returns JSON with a `default-src 'none'` policy,
`Cache-Control: no-store` and `nosniff` on every answer.

**Errors and logs**: errors are a fixed vocabulary; framework messages (which quote input) are replaced by fixed
sentences; the 404 no longer echoes the request; an unexpected failure is a fixed sentence and a request id. The
log records a request's method, path (never the query string), id and status, and nothing else about it: not
headers, body, cookies or address. Redaction (a second line of defence) covers credentials, tokens, sign-in
links and email fields at the top level and one level down. Security events (`bad_origin`, `rate_limited`,
`sign_in_failed`, `sign_in_locked`, `quota_exceeded`, `overloaded`, `idempotency_conflict`, `sessions_revoked`,
...) are structured lines carrying an address *tag* and, if signed in, a user id. The public `/health` and
`/ready` endpoints return a fixed message when the database is down. Vendor error bodies are never logged or
returned verbatim.

**Deployment information**: `/v1/providers` does not name the environment variables that would enable a missing
source, and `/v1/providers/health` (live, some billed) is off, in production; both are on in development.

**Data handling**: a provider's revalidation token is stored with the trip but blanked in every response except
the owner's own export. Every store write is checked for the version that was read (optimistic locking), so two
changes cannot silently overwrite each other; a request that can be repeated safely can carry an
`Idempotency-Key`. Only places, routes and things to do are cached, keyed by every parameter and validated on the
way out; nothing about a person is cached.

**Telemetry (Phase 7)**: one logging system (the redaction above applies), one error vocabulary, correlation ids
carried from the request into the queued run and the worker. Spans carry an allow-listed, length-capped set of
attributes, never an exception message, a store argument, a prompt or an answer; metric labels are closed sets
or capped strings and never an id; an inbound `traceparent` is ignored. `/metrics` and `/ops/status` answer 404
unless `OPS_TOKEN` is set, then need a bearer token compared in constant time, with lockout. Planted secrets are
searched for in every span, metric and log line by tests. See [docs/observability.md](docs/observability.md).

**Knowledge answers (Phase 8)**: `POST /v1/knowledge/ask` needs a session, is rate limited per person and per
address, cannot name an index, treats a `tripId` as owner-only, and never states more about a failure than that
it is unavailable. The index is curated by an operator script (there is no ingestion endpoint): documents are
validated, screened for instruction-like text, encoded payloads, hidden characters, secrets and personal data
(held in quarantine with reason codes, never searchable), versioned (an older document never replaces a newer one)
and de-duplicated; source links are checked and never fetched. Retrieved text reaches a model only as escaped data;
a model's claims must cite retrieved chunks and are checked against them in code, and what a traveller reads is
that, or "Insufficient verified information.". See [docs/knowledge.md](docs/knowledge.md).

**Booking safeguards, kept for when booking returns**: the state machine, the rule that a client can never send a
payment or provider event, atomic per-user idempotency, and a state check so a transition applies at most once.
They are tested, and unreachable over HTTP today.

**Production refusals**: the service will not start in production without `SESSION_SECRET` (minimum 32
characters; `JWT_SECRET` is read as its old name) or without `DATABASE_URL`, and refuses `MAILER=console`.

**Containers** run as an unprivileged user and contain only production dependencies and compiled output.

---

## Known limitations

These are real. Treat them as prerequisites before running this for other people.

- **This has not been penetration tested, and no external service has been used live.** The audit was by the
  authors, with tests. Provider response schemas come from documentation and hand-written fixtures; Redis,
  PostgreSQL behind a pooler, Docker, CI and the mail webhook were not exercised live.
- **The agents have only been exercised against scripted models.** Their boundaries are tested with models that
  return garbage, obey injected instructions and fail; no real language model has been run through them, and how
  a real one behaves against these checks is unmeasured. Prompt injection is reduced, not eliminated.
- **Knowledge answers are only as good as the index, and only as safe as who may write to it.** A plausible,
  screen-clean document that states an attacker's falsehood in plain words passes every layer (reproduced in the
  evaluation as a known limitation); ingestion is trusted by design. The screen is a tripwire: a phrasing it has
  never seen passes it. The answer verifier is lexical: it stops an invented figure, source, link, promise or reversed
  "not", but accepts a sentence that recombines a source's own words and figures into something it does not say
  (measured: 3 of 3 such cases). **No real embedder and no real language model has run through this layer**; the
  evaluation uses an offline embedder that matches shared words, not meaning, and scripted models. Exact search is
  measured on 27 chunks. Details and numbers: [docs/knowledge.md](docs/knowledge.md).
- **Observability was built and tested without a collector, a Prometheus server or Grafana.** The alerts are written
  down, not wired. A worker running without the API serves its own `/metrics` only when `WORKER_METRICS_PORT` and
  `OPS_TOKEN` are set. Traces go to whatever OTLP endpoint the operator configures; what leaves the process is the
  allow-listed attributes above.
- **A hard requirement stated in words can be missed, but not invented**, and later words do not withdraw earlier
  hard requirements they do not mention.
- **Anonymous sessions are cheap to make, but an address is bounded.** Each anonymous person has an allowance;
  what stops a new one restarting it is the per-address counting (the limits above), which is only as good as
  `TRUST_PROXY` (behind a proxy that is not configured, everyone shares one address; with too much trust, callers
  choose their own). Someone with many addresses (a botnet, a large IPv6 allocation beyond one /64) is not
  stopped by any of it: put a CDN or WAF in front for that, and set provider-side quotas.
- **Per-process fallback multiplies limits.** While Redis is unreachable each API process counts for itself, so the
  effective limit is up to the number of instances times the configured one.
- **Sign-in is an emailed link only.** No second factor; whoever controls the mailbox controls the account.
  There is no session list (only sign out here / everywhere) and no account recovery beyond a new link.
- **The inline-script allowance in the web CSP** is Next.js's; a nonce per request needs middleware this app does
  not have. The web client does not yet send `Idempotency-Key`. The Google Fonts stylesheet is a third-party
  request.
- **A trip with no owner is unreachable.** Rows created before accounts existed cannot be opened by anyone.
- **A search that is cancelled or times out stops calling providers it has not reached and aborts calls in flight,
  but a provider may already have counted a request it received.**
- **The mail webhook is unverified against a real mail service** and has no retry: a failed delivery is reported
  to the traveller, who can ask again.
- **Free text is stored and shown back.** It is bounded, single-line, stripped of hidden characters and rendered
  as text, but any future feature that puts stored text into a prompt or a page must treat it as hostile.
- **Traveller documents are not encrypted by the application**, and nothing stores them in this release. The
  schema carries `encrypted` and `nonce` columns and the repository is shaped for it, but the implementation
  stores the serialised record. Implement encryption before booking is enabled.
- **The audit trail is thin.** Trip creation, consent answers, pin changes, search start/finish and sign-ins
  are recorded; reads are not. It records that things happened, not what was said.
- **Logs contain user ids and address tags**, which identify a person to anyone who also has the database and the
  secret. They contain no email address, cookie, token, query string or free text; ship them accordingly.
- **Compose publishes PostgreSQL and Redis on the host** with a default password (and Redis with none). It is a
  local development convenience; do not use it as a deployment.
- **The PostgreSQL tests use a throwaway local server, not a managed one.**
- **`npm audit` fails at baseline**; the fix needs Next 16 / Vitest 5 majors, which are forbidden here.

---

## Reporting scope

In scope: authentication and authorisation flaws, injection, SSRF, secret leakage, anything letting a client set a
booking state a provider or payment processor alone should set, idempotency and rate-limit bypasses,
prompt-injection paths that change what a plan says or does, and anything causing the system to present
fabricated travel data as real.

Out of scope: the known limitations above (already documented), vulnerabilities in third-party provider APIs,
findings that require a malicious operator with environment access, volumetric denial of service, and rate
limiting on a deployment that has disabled it.
