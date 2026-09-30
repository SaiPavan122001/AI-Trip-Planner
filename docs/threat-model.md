# Threat model (Phases 6, 7 and 8)

Written before the Phase 6 changes, from reading the code as it stood after Phase 4, and revised as each
finding was fixed. It lists what an attacker (or an accident) could realistically do to *this* system, what
already stood in the way, what was missing, and what was done. It is a working document: a row that says
"fixed" names the test that holds the fix in place.

The system in one paragraph: a browser talks to a Fastify API. Every visitor is a user (anonymous until they
sign in with an emailed link) with an HttpOnly cookie session. The API stores trips (a JSON document per
trip) and a queue of background searches in PostgreSQL. A worker runs each search through deterministic
code and a few LLM-backed agents that only read text and propose soft preferences; providers (Nominatim,
OSRM, Amadeus, Google, a rail/bus contract, a mail webhook, an LLM endpoint) are reached over HTTPS with
operator-configured base URLs. Booking and payment do not exist and every booking route answers 501.

## Assets

| Asset | Why it matters |
|---|---|
| Provider credentials, LLM key, `SESSION_SECRET`, mail webhook token | Spend money, or impersonate users |
| Provider quota and the operator's bill | Every search and every model call costs money |
| Trips (places, dates, party size, free text) | Reveal when and where someone will be away |
| Email addresses | Identify a person; the only sign-in factor |
| Availability | A planner that is down is useless; a search that hangs holds a worker |

Not held, by design: passports, dates of birth, payment data. Nothing in Phase 5 or 6 adds them.

## Trust boundaries

1. Browser → API (untrusted client, hostile input).
2. API → PostgreSQL / Redis (trusted, but can fail).
3. API → providers (semi-trusted: they can be slow, wrong, hostile, or compromised).
4. Any text → an LLM (untrusted content in, untrusted output out).
5. API → mail webhook (operator-owned, receives sign-in links).

## Threats

Status: **Held** = a control existed before Phase 6 and was kept (with the test that shows it); **Fixed** = a
gap found in this phase, fixed and tested; **Limit** = a residual risk that is documented, not solved.

### Abuse and exhaustion

| # | Threat | State before | Phase 5/6 outcome |
|---|---|---|---|
| A1 | **Unauthenticated abuse** of the routes that cost money (`/v1/requirements/interpret`, `/v1/places`, `POST /v1/trips`) | Per-route limits keyed on the person, else the address | **Fixed**: every limited route is also counted per address, whatever cookie is presented (`rate-limit.test.ts`) |
| A2 | **Anonymous-cookie rotation.** Creating a new anonymous user (one `POST /v1/trips` without a cookie) gave a new rate-limit identity *and* a new daily search allowance | 30 first trips an hour per address, then 12 plans a minute *per new cookie* | **Fixed**: an address-level dimension on every limit, plus a per-address daily cap on searches started by anonymous users (`rate-limit.test.ts`: "anonymous cookie rotation") |
| A3 | **Authenticated abuse**: a signed-in user flooding searches | Daily quota per user, one active run per trip, per-route limits | **Fixed**: also a cap on active runs per user, so many trips cannot fan out (`overload.test.ts`) |
| A4 | **Overload**: many searches at once | RUN_CONCURRENCY workers, but the queue was unbounded and a queued run could wait forever | **Fixed**: bounded queue (`503 busy` + `Retry-After`), per-user active cap, stale queued runs expire (`overload.test.ts`) |
| A5 | **Resource exhaustion by payload**: 1 MB bodies, unbounded strings (`planId`), unbounded headers | 1 MB body limit; most fields bounded by Zod | **Fixed**: 64 KB body limit, every string that reaches the API has a maximum, idempotency keys are validated |
| A6 | **Slow provider holds the whole request.** One provider could use the 45 s call budget out of a 60 s search and lose everything | Per-call 45 s deadline only | **Fixed**: layered budgets; each stage has a share of the run's deadline and a slow provider costs its own results only (`resilience-budgets.test.ts`, `resilience-retries.test.ts`) |
| A7 | **Retry storms** against a failing provider | Two retries per call, no ceiling on total time, no memory of failure | **Fixed**: retries respect the deadline and a per-host retry budget; circuit breakers stop calling a provider that is down |
| A8 | **Provider quota exhaustion** by a single busy period | None | **Fixed** in part: cache for stable lookups, breaker, address caps. **Limit**: no per-provider daily quota accounting |
| A9 | **Email abuse** (sign-in mail as a harassment channel) | 5 per recipient per hour, 10 per caller per hour | **Fixed**: per recipient (however many callers ask), per person, per address per hour and per day (`auth-security.test.ts`) |
| A10 | **Webhook abuse**: the mail webhook is a fixed operator URL | Redirects refused, 10 s timeout | **Held**; config is now validated at start (scheme, no embedded credentials, https in production) |

### Identity, sessions, authorisation

| # | Threat | Outcome |
|---|---|---|
| I1 | **IDOR / BOLA**: user A reads or changes user B's trip, plan, run, pins, selection, modification or cancellation | **Held**: every route resolves the trip through `owned()`, which answers 404 for someone else's trip, and runs are checked against the trip they belong to. Phase 6 adds a route-by-route cross-user test (`authorization.test.ts`) that walks every trip route as a stranger and as no one |
| I2 | **Session theft / fixation** | **Held**: 256-bit token, only its HMAC stored, fresh session on every sign-in, `HttpOnly`, `SameSite=Lax`, `Secure` in production. **Fixed**: an absolute session lifetime (the old sliding renewal never expired an active session), and a "sign out everywhere" endpoint |
| I3 | **Magic-link replay / prefetch** | **Held**: single-use, consumed atomically, exchanged by POST |
| I4 | **Account enumeration** | **Held**: the link request answers the same for known and unknown addresses (test) |
| I5 | **Repeated failed sign-in** (guessing a link token) | **Fixed**: failed verifications are counted per address and locked out (`auth-security.test.ts`); tokens are 256 bits so guessing is not the risk, the cost of the lookups is |
| I6 | **Privilege escalation** through mass assignment | **Held**: bodies are parsed by Zod schemas that name every accepted field (zod strips the rest); ownership, version and totals come from the server, and a test sends `ownerId`/`version`/`plans` on create and answer and checks none is taken. **Fixed**: `strict()` on the route bodies that had none (modify, select, pins, consent, requirements, plan, sign-in, delete account), so an unexpected field is refused, not ignored |
| I7 | **CSRF** | **Held**: `SameSite=Lax` cookie, `Origin` must be allow-listed on any request that changes something. **Fixed**: a request with no `Origin` but `Sec-Fetch-Site: cross-site` is refused too |
| I8 | **Unauthenticated read of operational data**: `/v1/providers` names the environment variables that would enable a provider; `/v1/providers/health` makes billed calls | **Fixed**: in production the variable names are not returned, and the live probe is off unless enabled, cached and single-flight |

### Injection and untrusted content

| # | Threat | Outcome |
|---|---|---|
| J1 | **SQL injection** | **Held**: Prisma's query builder everywhere; the two raw queries use tagged templates (bound parameters). Checked by reading every `$queryRaw`/`$executeRaw` |
| J2 | **Command injection** | **Held**: nothing in the API or packages spawns a process (checked by search) |
| J3 | **XSS** | **Held**: React escapes everything; no `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `document.write` in the web app (checked by search; a test keeps it that way). **Fixed**: a Content-Security-Policy and the other browser headers on the web app; the one `href` built from API data (the development sign-in link) is scheme-checked |
| J4 | **Prompt injection** in traveller text, provider text or destination text | **Held**: the model classifies or proposes, never decides; every output is schema-checked and sanitised; text is data in a tagged block. **Fixed**: the tag delimiters could be closed from inside the text (JSON escaping does not escape `<`), so `<`, `>` and `&` are now escaped in every data block, and control and bidirectional-override characters are removed before text reaches a model (`prompt-safety.test.ts`) |
| J5 | **Tool authorisation via the model**: a model asking to act for someone else | **Held and tested**: the model has no tools. Its output is parsed into a closed set of intents; authorisation (`owned()`), consent, pins and the budget rules are applied afterwards in code. Test: a hostile model output cannot make a stranger's trip change |
| J6 | **Malicious provider data** (script in a hotel name, a link claiming a booking, a price that is not a number) | **Held**: schema-checked at the adapter; text cleaned by `safeText`; narratives fact-checked. |
| J7 | **Mass assignment / overposting** | See I6 |

### Network

| # | Threat | Outcome |
|---|---|---|
| N1 | **SSRF through a redirect**: a provider (or something between) redirecting `httpJson` to an internal address; `fetch` followed redirects by default | **Fixed**: redirects are never followed blindly; a redirect is allowed only to the same origin, is capped, and is validated (`resilience-retries.test.ts`, `ssrf.test.ts`); the OpenAI-compatible LLM adapter refuses redirects (`openai-adapter.test.ts`) |
| N2 | **SSRF through a user-supplied URL** | **Held by absence**: no API input is used as a URL or host. Place names and codes are query parameters, encoded by the URL API. The guard (`checkOutboundUrl`) exists for the day one is: it blocks non-HTTP schemes, embedded credentials, loopback, private, link-local and cloud-metadata addresses, and resolves names before deciding |
| N3 | **SSRF through operator config** (a misconfigured base URL pointing at an internal service) | **Fixed** in part: URLs are validated at start (scheme, no credentials, https in production). An operator may deliberately use a private OSRM; that is allowed for configured provider URLs and refused for anything derived from a response |
| N4 | **Stampede on the token endpoint** (many parallel calls each fetching an OAuth token) | **Fixed**: one in-flight token request is shared |

### Data exposure

| # | Threat | Outcome |
|---|---|---|
| D1 | **Secrets in logs** | **Held**: header/field redaction. **Fixed**: redaction extended to tokens, links and email fields at the top level and one level down (a test found that the first attempt only covered one level); the request logger writes method, path, id and status only, not headers, bodies, query strings or addresses; the console mailer is development-only and refused in production (`leakage.test.ts`) |
| D2 | **Secrets in errors/responses** | **Held**: vendor bodies are never returned. **Fixed**: the 404 handler no longer echoes the request URL; 4xx errors from the framework are reduced to a fixed vocabulary; every response carries `Cache-Control: no-store`; `/v1/providers` no longer names environment variables in production, including in the per-capability messages, which the first attempt missed (`hardening.test.ts`, `leakage.test.ts`) |
| D3 | **Secrets in the repository** | **Held**: `.env` ignored, `.env.example` placeholders only, CI runs gitleaks. Checked by scanning the working tree (a test) and the whole of git history (25 commits) for credential patterns, counts only: no hits, apart from the documented local development database login (user `wayfare`, the compose default password) in docs, compose and tests. gitleaks itself was not available here |
| D4 | **Insecure export/download** | **Held**: `Content-Disposition: attachment`, `nosniff`, owner only. **Fixed**: `no-store`, so a shared cache cannot keep it |
| D5 | **Sensitive data in analytics** | **Held by absence**: there is no analytics. The web app loads a Google Fonts stylesheet (a third-party request); documented |
| D6 | **PII minimisation**: what is stored | Email (users), trip intent and free text, the traveller's change requests (decision log, pending change), audit events (user id, kind). No documents, no payment. Retention is until deletion, plus the housekeeping sweep of abandoned anonymous accounts. **Limit**: no automatic expiry of signed-in users' trips (needs a product decision) |
| D7 | **Cache leakage between users** | **Designed out**: only provider responses that do not depend on who asked (places, routes, place details) are cached; keys contain every request parameter; nothing user-specific, no plans, no authorisation decisions are cached (`resilience-policy.test.ts`: "caching") |

### Telemetry (Phase 7): logs, metrics and traces are a surface too

Everything above about logs (D1) still holds; Phase 7 adds spans, metrics, and two operator endpoints. Design in
`docs/observability.md`; the tests are `packages/telemetry/src/__tests__/telemetry.test.ts` and
`apps/api/src/__tests__/observability.test.ts` ("holds no cookie, token, email address, address, or traveller's words in any
span, metric or log line").

| # | Threat | Outcome |
|---|---|---|
| T1 | **Sensitive data in a span, metric or log**: cookies, `Authorization`, prompts, what a traveller wrote, an email, an address, a stack trace | **Held by construction, not by review**: span attributes pass a name filter and a length cap (`safeAttributes`); exception *messages* are never put on a span (class, category and frames only; the message is logged only when `LOG_ERROR_MESSAGES`, off in production); store operations are recorded by name only, never their arguments; LLM spans carry provider, model, task and token counts, never a prompt or an answer. Each has a test that plants a secret and looks for it in every span, metric and log line |
| T2 | **Unbounded label values** (a metric series per user or per trip: memory exhaustion, and a way to read who was active) | **Held**: every label is a closed set or a capped, sanitised string; a registry-wide cap drops new series and counts `telemetry_series_dropped_total`. No user, trip, run or request id is ever a label (ids are in logs and traces only) |
| T3 | **Reading `/metrics` or `/ops/status` without permission** | **Held**: 404 unless `OPS_TOKEN` is set; then a bearer token compared in constant time; an address is locked out after 10 wrong tokens in 15 minutes; both routes are rate limited. They carry states, counts and closed labels, never a person, a trip or a secret |
| T4 | **Trace-context injection**: a caller sends a `traceparent` to join or pollute a trace | **Held**: an inbound `traceparent` is ignored (the trace is ours to start); the one stored in a run row is validated as W3C format before it is continued |
| T5 | **Log injection** through an identifier containing a newline or a forged field | **Held**: logs are JSON (a newline is an escape), and request and run ids are validated (`safeId`) before they enter a log or a span |
| T6 | **Trace export as an exfiltration path** | **Accepted, bounded**: spans go only to the operator-configured OTLP endpoint, and only carry the attributes T1 allows |

### Knowledge index and retrieval (Phase 8)

`POST /v1/knowledge/ask` answers from a shared, curated index. Design, evidence and residual risk: `docs/knowledge.md`
(sections 3, 9, 10, 12). Tests: `packages/knowledge/src/__tests__/security.test.ts`, `eval.test.ts` (injection set),
`apps/api/src/__tests__/knowledge.test.ts`, and 19 mutation checks (remove a protection: a test fails).

| # | Threat | Outcome |
|---|---|---|
| K1 | **Indirect prompt injection**: an instruction inside a retrieved document | **Held in depth, not absolutely**: five layers (ingestion screen, retrieval-time screen, escaped data blocks, cited-chunk-only claims checked by code, a model with no authority). 21 of 21 evaluated attacks were stopped by the pipeline as built; with the two screens removed the verifier alone stops 19 of 21. **Not held**: a plausible, screen-clean document that states the attacker's falsehood in plain words (K2) |
| K2 | **Data poisoning**: a malicious or wrong document in the index | **Reduced, not solved**: ingestion is an operator script (no endpoint), authority is set by source type in code, older versions never replace newer, duplicates and conflicts are refused, disagreement between sources is shown and never resolved. Whoever can run the ingestion script can still poison the index; that is the trust boundary. Documented as a known limitation, and reproduced in the evaluation (`k01`) |
| K3 | **Malicious metadata or source link** (an instruction in a title, a link to an internal address, a credential in a URL, `javascript:`) | **Held**: metadata is screened like the body; a link must be https, with no credentials, no internal or private address and no credential-looking query key; a link is stored and shown, **never fetched** (a test fails if this package makes a network call for a document) |
| K4 | **Cross-user retrieval**: one traveller's data returned to another | **Held by absence**: the index has no owner, user, trip, session or email field (the schema is strict; tests reject each); nothing in the index belongs to a person. The namespace read is fixed by configuration, and nothing in a request can name one (test) |
| K5 | **Retrieval authorisation bypass** | **Held**: the route needs a session (401 otherwise); `tripId`, if given, must be the caller's own (a stranger's is 404, byte-identical to a missing one); ingestion cannot be reached from the API |
| K6 | **Secrets or personal data in a document, then served** | **Held**: such a document is quarantined (reason codes only, never the text); a question containing a secret is not echoed into an answer, a note, a span or a log line (test) |
| K7 | **Exfiltration through an answer** (a markdown image or link that leaks data when rendered) | **Held**: the screen flags exfiltration phrasing and markdown images; a claim may contain no link that is not in its sources; there is no web UI for answers yet, and when there is one it must render them as text with links through `safeHttpLink` |
| K8 | **Outdated or conflicting sources presented as fact** | **Held**: a document past `reviewBy` is not used and the answer says so; sources that disagree are both shown with version and date, never merged or chosen between |
| K9 | **Cost abuse** (many questions, each an embedding and a model call) | **Held**: session required, per-person and per-address per-minute and daily limits, one embedding per question, a model call only when retrieval found something to answer from, a deadline (`KNOWLEDGE_TIMEOUT_MS`) |
| K10 | **Mixing incompatible embeddings** (a changed model silently degrading search) | **Held**: every vector carries its space (`model@version:dimension`); a search is in one space; the store refuses different lengths; `/ops/status` says when the index was built with another embedder |
| K11 | **Exhausting the index or the process** (a huge document, too many chunks, a huge corpus) | **Held**: 200,000 characters and 500 chunks per document; exact search refuses past 20,000 chunks in one space instead of degrading |
| K12 | **Internals in an error** (a database address, a stack trace) | **Held**: a failing index or embedder is a fixed 503 sentence with `X-Error-Category`; the cause is logged by category (test plants a connection string and a password and looks for them) |

## Out of scope / accepted

- No second factor; whoever controls the mailbox controls the account.
- No DDoS defence: rate limits protect the application and its bill, not the network. Put a CDN or WAF in front for that.
- A stolen `SESSION_SECRET` lets an attacker forge nothing (cookies are random tokens whose HMAC is stored), but it lets them compute the hash of a token they have. It should still be rotated on exposure.
- Live provider behaviour, a real Redis, a managed PostgreSQL, Docker and CI are **not** exercised here. See `PROJECT_STATUS.md`.
