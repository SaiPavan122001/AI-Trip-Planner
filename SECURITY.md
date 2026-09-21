# Security

## Reporting a vulnerability

Please report privately, not in a public issue. Use GitHub's **Report a vulnerability** button under
the Security tab, or email the maintainers listed in the repository.

Include what you did, what happened, and what you expected. A proof of concept helps; a working
exploit is not required and we would rather you did not attach one.

We aim to acknowledge within three working days and to agree a disclosure timeline with you. We will
credit you unless you ask us not to.

---

## What this system handles

| Data | Sensitivity | Where it lives |
|---|---|---|
| Trip intent, preferences, itineraries | low | `trips.session` (JSON) |
| Traveller names, dates of birth | personal | `traveler_records` |
| Passport / national ID numbers | sensitive | `traveler_records` |
| Provider API credentials | secret | environment only |
| Payment card data | — | **never handled** |

Card data never reaches this service. There is no field for it in any schema and no code path that
would accept one. Payment authorisation is expected to happen client-side against a payment
provider; the booking state machine accepts only the resulting authorisation reference.

---

## Controls in place

**Secrets** live only in the environment. `.env` is git-ignored, `.env.example` contains no real
values, and CI fails if a `.env` file is ever tracked or if gitleaks finds a credential anywhere in
history — a key that was committed and then removed is still a leaked key.

**Logging** redacts by path rather than by discipline: `authorization` and `cookie` headers,
`*.apiKey`, `*.clientSecret`, `*.password`, `*.document` and `travelers[*].document` are censored at
the logger, so a passport number cannot reach a log line even by accident. Vendor error bodies are
never logged or returned verbatim; they are mapped to plain-language messages, because they
routinely carry internal identifiers.

**Traveller documents** are stored in a table of their own, separate from the planning session, so
retention and access rules apply in one enforceable place. The API never echoes them back in a
response.

**Input validation** happens at every boundary with Zod: request bodies, provider responses, and
documents read back out of the database. A provider that returns a response not matching the
documented contract has its results discarded and the search reports a provider error — failing at
the cause rather than somewhere far from it.

**Transport hardening**: helmet, an explicit CORS allowlist (`CORS_ORIGINS`), a 1 MB body limit, per-
request timeouts on every outbound call, bounded retries with jittered backoff, and per-provider
request pacing.

**Rate limiting** is keyed by user or IP. It protects the operator's provider bill as much as the
service, since planning fans out to paid APIs.

**Idempotency** is mandatory on booking mutations, which is what prevents a retried request from
creating a second reservation.

**Production refusals**: the service will not start in production without `JWT_SECRET` (minimum 32
characters) or without `DATABASE_URL`. Starting with the in-memory store in production would lose
every trip on deploy.

**Containers** run as an unprivileged user and contain only production dependencies and compiled
output.

---

## Known limitations

These are real and deliberate; treat them as prerequisites before running this for other people.

- **Traveller documents are not encrypted at rest by the application.** The schema carries
  `encrypted` and `nonce` columns and the repository interface is shaped for it, but the current
  implementation stores the serialised record. Enable database-level encryption, or implement
  application-level encryption in `PrismaRepository.saveTravelerDetails`, before storing real
  passport data.
- **Authentication is not implemented.** `X-User-Id` is trusted as supplied, which is fine for local
  development and unacceptable on a public deployment. Put an authenticating gateway in front, or
  implement verification of the `JWT_SECRET`-signed token the environment already provides for.
- **No audit of who viewed a trip.** `audit_events` exists in the schema and records planning
  decisions and waivers; read access is not audited.
- **No automated data retention.** Idempotency keys carry an `expiresAt`, but nothing sweeps them,
  and traveller records are kept until the trip is deleted.

---

## Reporting scope

In scope: authentication and authorisation flaws, injection, SSRF through provider configuration,
secret leakage, booking state machine bypasses (anything that marks a booking confirmed without a
provider reference), idempotency bypasses, and anything causing the system to present fabricated
travel data as real.

Out of scope: vulnerabilities in third-party provider APIs, findings that require a malicious
operator with environment access, and rate limiting on a deployment that has disabled it.
