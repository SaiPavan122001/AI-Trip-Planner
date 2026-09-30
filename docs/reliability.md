# Reliability, scalability and resilience (Phase 5)

What keeps the planner usable when providers fail, slow down, or are asked too much; when requests are
repeated or arrive in a crowd; and when Redis or the database has a bad moment. It builds on the Phase 3
provider architecture and the Phase 4 planner; nothing here replaces either.

**What this is not.** It does not claim unlimited scale. The limits below are deliberate ceilings that make the
service degrade in a stated way (a plain refusal, a note that a source timed out) instead of failing in an
unstated one (unbounded queues, a hung request, a run that throws away everything it found). None of it has been
tried against live providers, a real Redis, or a managed PostgreSQL: see "Not verified".

## The layers of time

A search has one deadline (`PLANNING_TIMEOUT_MS`, default 60 s). It used to have only a per-call limit
(`PROVIDER_CALL_TIMEOUT_MS`, 45 s), so one slow provider could use most of the search and the run would then
be killed, losing everything the other providers had found. Now each level takes a share of the one above, and
can only narrow it:

```
search deadline (PLANNING_TIMEOUT_MS)                     RunService, one hard stop
 ├─ guidance agents (parallel, each ≤ AGENT_TIMEOUT_MS)   the agent contract
 ├─ provider deadline = deadline − (AGENT_TIMEOUT_MS + 2 s) kept back for the explanation
 │    ├─ stage 1: journeys ∥ things to do    45% of what is left      withBudget()
 │    ├─ stage 2: places to stay             60% of what is left
 │    └─ stage 3: itineraries (transfers)    the rest; each transfer lookup ≤ 10 s
 │         └─ one provider call: min(PROVIDER_CALL_TIMEOUT_MS, what its stage has left)   ResilientPolicy
 │              └─ one HTTP attempt: min(its timeout, what the call has left)             httpJson
 ├─ validation (arithmetic)
 └─ explanation (one model call, ≤ AGENT_TIMEOUT_MS, then a template)
```

* `withBudget` (`packages/providers/src/call-scope.ts`) gives everything started inside it a signal that fires on
  cancellation *or* when its time is up, the deadline itself, and a shared allowance of HTTP requests. It travels with
  the call (`AsyncLocalStorage`), so it applies to code that never passed a `signal` on: two adapters did not, and
  cancelling a search left their requests running.
* A call cut short by its *stage's* time is reported as timed out **and marked `local`**: it says nothing about the
  provider, so the circuit breaker does not count it.
* A provider that hangs therefore costs its own results and the time its stage allowed; the stages after it still
  run (`packages/engine/src/__tests__/resilience-budgets.test.ts`). The run finishes with the plans that could be
  built and a "timed out" note for what could not.
* The hard stop remains for work that is not a provider call. A search whose own code will not finish is failed
  with `planning_timeout`.

## Retries (`packages/providers/src/http.ts`)

Retried: the connection failed, one attempt timed out, or the answer was 408, 500, 502, 503 or 504; and only a
request that is safe to repeat (a GET by default; a POST only if the caller says the endpoint is idempotent).
Never retried: any other 4xx, **429** (the provider said to stop; the failure carries `retryAfterSeconds` and the
circuit breaker honours it), an unusable body, a refused redirect, a cancellation.

Bounded by: a count (`PROVIDER_MAX_RETRIES`, 2); an exponential delay with jitter and a ceiling
(`PROVIDER_RETRY_MAX_DELAY_MS`, 3 s); the call's deadline (a retry that would not fit, with its wait, in the time left
is not started, and each attempt gets only the time left); and a per-host **retry budget** (10 to start, +0.2 per
request) so a provider failing everything is not hit harder for it. Sleeping between attempts is abortable.

## Circuit breaker (`packages/providers/src/policy.ts`)

One breaker per `provider:capability` (Amadeus failing on hotels does not stop flights). `CLOSED` counts consecutive
failures (`unavailable`, `timeout`, `invalid_response`); at `PROVIDER_CIRCUIT_FAILURE_THRESHOLD` (5) it goes `OPEN`
and the provider is **not called** for `PROVIDER_CIRCUIT_RECOVERY_MS` (30 s); then `HALF_OPEN` lets one probe
through; a success closes it, a failure reopens it for another full period. A `429` opens it for the provider's
`Retry-After`. Not counted: "nothing found", a request the provider refused as malformed, rejected credentials,
and anything `local` (cancelled, out of stage time, request allowance spent, request line full).

A skipped call says so, and repeats the last real failure: *"X was not asked, because it has been failing … Its last
failure was: …"*. The language model has its own breaker (`TripLlm`, 4 failures, 30 s), so a dead model costs one
timeout, not one per agent per search. It is part of `ResilientPolicy`, the registry's default `ProviderPolicy`; there
is no second execution framework.

## Fallback (`packages/providers/src/fallback.ts`)

Search capabilities ask every provider at once and keep every answer (`sweepProviders`), as before. Fallback is for
"one answer wanted, several providers can give it": a drive measured by Google (traffic-aware) falls back to OSRM.
The first provider that answers wins; failures before it are kept in the answer's `warnings` ("Google Routes: … OSRM
answered instead"), the drive says which provider measured it, and if every provider fails the failure lists them all.
A cancelled search does not go on to the next provider. Place lookups (`TripService.resolvePlace`) fall back across
geocoders the same way, through the policy. Nothing is ever invented.

## Caching (`packages/providers/src/cache.ts`)

Cached: place lookups (24 h), road routes (6 h; a traffic-aware answer is keyed to the half hour of departure), things
to do (6 h). **Not** cached: flights, hotels, rail, bus (prices change by the minute; offers carry their own re-pricing
token), plans, trips, anything about a person, authorisation decisions, and any failure or "nothing found". Keys are
`wf:v1:<provider>:<operation>:<sha256 of every parameter>`; the value is checked against the same schema as a fresh
answer, so a stale or tampered entry is a miss; entries expire; the in-process store is bounded
(`CACHE_MAX_ENTRIES`); a store that cannot be reached is a miss. The cached answer keeps its original retrieval time.
Callers asking for the same thing at once share one call, unless it was cut short by *its* caller's cancellation.
With `REDIS_URL` the store is shared by every API process.

## Rate limiting (`apps/api/src/security/rate-limit.ts`, `infra/counters.ts`)

Every request is counted on the **person** and on the **address**, and both must have room. The address dimension is
what makes the limits mean something: an anonymous person is one cleared cookie away, so a limit on the person alone
restarted every time. The address ceiling is higher than the person's (shared addresses). A caller with no person yet
is held tighter (`anonymous_address`). IPv6 counts by /64. An address is only ever a keyed hash (`HMAC(SESSION_SECRET)`),
also in Redis keys and logs. Named per-route policies: creating a trip, searches, changes, reading words (may call a
model), place lookups, sign-in emails (per person, per address, per day, and per recipient in the database), sign-in
attempts (plus a lockout after failed ones), account export/delete.

Counters are fixed windows; in Redis a window is created and counted in one transaction (`SET NX PX; INCR; PTTL`), so
concurrent instances cannot both start one. If Redis is unreachable the counters fall back to **this process's
memory**: the limit still applies (per process, so up to N× with N instances) and a warning is logged once a minute.
It fails toward limiting, not toward unlimited paid searches. Responses carry `RateLimit-*` and, on 429, `Retry-After`.

## Idempotency (`apps/api/src/security/idempotency.ts`)

`Idempotency-Key` (8–128 of `A-Za-z0-9_.:-`) on: create a trip, start a search, change request and its consent,
apply what was said in words, cancel, ask for a sign-in email. Claimed atomically in the existing
`idempotency_keys` table, scoped to the person, route and target. Same key and request → the first answer, replayed
with `Idempotent-Replay: true`; same key while the first runs → 409 `idempotency_in_progress` (`Retry-After: 2`);
same key, different request → 422 `idempotency_key_reused`; a request that fails releases its key. Answers are kept
24 h and swept by housekeeping. Reads do not use it. Starting a search is also naturally idempotent (a running search
for the same inputs is returned with `reused: true`). **The web client does not send keys yet**; a client that retries
must reuse the key.

## Overload and admission control

Checked before a search is created, none of them queues work to fail later: the person's daily allowance (database,
exact), the address's daily allowance for anonymous people, the person's active searches (`MAX_ACTIVE_RUNS_PER_USER`),
and the queue depth (`MAX_QUEUED_RUNS`; past it `503 busy` with `Retry-After`). Queued searches that wait longer
than `RUN_QUEUE_TIMEOUT_MS` are dropped by workers (one statement against the database clock). Workers run at most
`RUN_CONCURRENCY` searches. A search may make at most `MAX_PROVIDER_REQUESTS_PER_SEARCH` HTTP requests. Bodies are
capped (`MAX_BODY_BYTES`, 64 KB). A change that cannot start its search is turned away *before* anything is saved;
if the queue fills at the last moment the change is kept, the trip is put back to a state a person can act on, and the
answer says the search could not be started (it used to leave the trip marked "searching" with nothing searching).

## What was measured, and what it led to

`npx tsx packages/engine/scripts/measure-plan.ts` runs a whole plan search against fake providers that each take
150 ms. Before: 13 provider calls, 1853 ms, 9 of the calls (73% of the time) transfer lookups made one after another,
three archetype builds serialised, identical legs asked for repeatedly. After: 9 calls, 844 ms (−54%): the three plans
are built together (their results are put in order afterwards, so the outcome is unchanged: the existing determinism
tests pass) and identical transfer lookups within a search share one call. Also found by reading, not measurement:
`GET /v1/me` loaded fifty whole trips to count them, and `GET /v1/trips` returned every trip's full document; the list
now returns summaries. Amadeus token requests are single-flighted; the request pacer no longer keeps a cancelled
request in line. Database indexes: every query pattern was checked against the existing indexes
(`trips(ownerId, updatedAt)`, `planning_runs(status, createdAt)`, `(tripId, createdAt)`, `(ownerId, createdAt)`,
`login_challenges(email, createdAt)`, expiry indexes for housekeeping) and none was missing, so none was added.

## Failure behaviour

| Failure | What happens |
|---|---|
| Provider hangs | Cut at its stage's share; "timed out" note; other providers' results kept; not counted against its circuit |
| Provider 5xx / network | Bounded retries (GET), then a failure note; circuit opens after repeated failures |
| Provider 429 | No retry; circuit opens for `Retry-After`; note says rate limited |
| Provider sends nonsense | `invalid_response`, discarded, counted toward the circuit; a bad row is dropped, not the list |
| Every provider of a capability down | No results, a note per failed source, no exception, nothing invented |
| Primary routing down | Fallback provider answers; the answer names it and says what failed |
| Redis down | Cache misses; counters per process; one warning a minute; no request fails |
| Database blip on a read | 500 with a fixed sentence and a request id; worker keeps polling |
| Plans cannot be saved | Run marked failed with a plain message; detail in the log only |
| Cancelled mid-search | Every request in flight is aborted, including transfer lookups; nothing is retried |
| Duplicate / concurrent request | Idempotency key or the one-active-run rule; exactly one execution |
| Overload | `503 busy` (with when to come back), `429` for a person or address over its share |
| Knowledge index or embedder down | `503 knowledge_unavailable` (fixed sentence, category header) for that endpoint only; planning is unaffected because it never calls it |
| Model down or off-schema during a knowledge answer | The sources are quoted instead; never an error to the traveller |
| Embedding call for a new document fails | The previous version stays in place; nothing half-written (ingestion is one transaction) |
| Knowledge index past 20,000 chunks in one space | Search refuses loudly rather than getting slowly worse (move to pgvector or Qdrant) |

Observability of these failures (which metric, log line and span shows each) is in [observability.md](observability.md), and how
to find a bottleneck with them; how knowledge answers fail safe is in [knowledge.md](knowledge.md).

## Not verified

No live provider, Redis server, managed PostgreSQL, Docker or CI was used. `RedisCounterStore` and `RedisCache` are
tested against an in-memory stand-in that implements the commands used (`SET NX PX`, `INCR`, `PTTL`, `GET`,
`MULTI/EXEC`), not against Redis. The stage shares, breaker thresholds, retry budget and cache lifetimes are
reasoned defaults, not tuned against real traffic; each is a setting. The per-process fallback multiplies limits by
the number of instances while Redis is away.
