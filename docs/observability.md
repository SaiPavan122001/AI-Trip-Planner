# Observability (Phase 7)

Phase 7 answers one question: **what is the system doing, and why is it slow or failing?** (Phase 8 answers a
different one: whether the AI's answers are correct and grounded. See [knowledge.md](knowledge.md).)

There is one logging system (pino, with the Phase 6 redaction), one tracing model (OpenTelemetry), one
metrics registry (Prometheus text), and one vocabulary for failures. All four share the same identifiers. No
observability platform is bundled or required: a process with nothing configured logs to stdout, creates spans
that only give its logs their ids, and keeps its metrics in memory for `GET /metrics`.

```
                         requestId ─────────────────────────────────────────────┐
HTTP request ──span http.request                                                │
   │  (queues a run; the run row stores { traceparent, requestId })             │
   ▼                                                                            │
planning run ──span planning.run  (continues the request's trace, any process)  │
   ├─ planning.stage: guidance ── agent.transport / accommodation / activity    │
   ├─ planning.stage: plan_search                                               │
   │     ├─ stage search ── provider.call (flights, trains, buses, activities…) │ every log line carries
   │     ├─ stage hotels ── provider.call                                       │ requestId, runId, tripId,
   │     └─ stage assemble ── provider.call (transfers)                         │ traceId, spanId
   ├─ planning.stage: validation                                                │
   ├─ planning.stage: synthesis ── agent.synthesis ── llm.call                  │
   └─ db.operation (every store call made inside a trace) ──────────────────────┘
```

## Correlation

| Identifier | Names | Where it comes from |
|---|---|---|
| `requestId` | one HTTP request | the request's id (a random UUID); returned as `X-Request-Id` |
| `runId`, `tripId` | one planning run and its trip | random UUIDs; not personal data |
| `traceId`, `spanId` | a position in a trace | the active span |

They travel with the work (`AsyncLocalStorage`, `packages/telemetry/src/context.ts`), so code deep in an adapter
that logs or measures something is attributed correctly without anyone passing an id down. A queued search is picked
up later, possibly by another process: the run row's `params.trace` holds the request's `traceparent` and id (identifiers
only), and the worker continues that trace, so the HTTP request, the run, every agent and every provider call are one
trace and one `requestId`. A run queued before this existed simply starts its own trace. A `traceparent` header sent
by a caller is **not** continued (anyone could send one); identifiers reach a user only as `X-Request-Id`.

An identifier is validated before it is accepted (`safeId`, `validTraceparent`), so it cannot carry text into a log
line or a metric.

## Logs

pino, JSON, one system. Every line has `time`, `level`, `msg`, `service` (`trip-api`, `trip-worker`), `env`, and, when
there is one, `requestId`, `runId`, `tripId`, `traceId`, `spanId` (added by a pino `mixin`, so no call site does it).
Operations that matter write a standard line with an `operation` field:

| `operation` | Written when | Fields beyond the above |
|---|---|---|
| `planning.run` | a run finishes, whichever way | `outcome`, `kind`, `attempt`, `queueWaitMs`, `planningMs`, `errorCategory` |
| `planning.queue_expiry` | waiting runs were dropped | `dropped` |
| `provider.circuit` | a circuit opens, half-opens or closes | `circuit` (`provider:capability`), `fromState`, `toState` |
| `db.slow` | a store operation exceeded `SLOW_DB_MS` | `dbOperation` (a name), `durationMs`, `outcome` |
| `http.request` | an unexpected failure (500) | `errorType`, `errorCategory`, `errorFrames` |
| security events | `security: "rate_limited" \| "bad_origin" \| …` (Phase 6) | address **tag**, user id |

Errors are logged by `describeError`: the class, the category, the top of the stack (file names and lines: where,
not what), and the **message only if** `LOG_ERROR_MESSAGES` is on (default: on outside production, off in production),
because an exception's message routinely quotes what was rejected. Redaction (Phase 6) still applies to every field.
(A regression this caught: the redaction list includes a top-level `to`, which is where an email address goes; a
circuit's `to` state was being redacted, so those fields are `fromState`/`toState`.)

## Traces

OpenTelemetry API in the libraries (no-ops without an SDK); the SDK is installed by the API/worker
(`setupTracing`, `packages/telemetry/src/sdk.ts`). Without configuration spans have valid ids (logs correlate) and go
nowhere. `OTEL_EXPORTER_OTLP_ENDPOINT` exports them over OTLP/HTTP; `OTEL_TRACES_SAMPLER_ARG` samples new traces
(parent-based: an unsampled span still has ids, so logs stay correlated when traces are thinned).

| Span | Attributes (all of them) |
|---|---|
| `http.request` (server) | `http.request.method`, `http.route` (the pattern), `http.response.status_code`, `error.category`, correlation |
| `planning.run` (consumer) | `planning.kind`, `planning.attempt`, `planning.queue_wait_ms`, `planning.outcome`, `planning.duration_ms`, `error.category`, `error.type` |
| `planning.stage` | `planning.stage` (`guidance`, `search`, `hotels`, `assemble`, `plan_search`, `validation`, `synthesis`) |
| `agent.<name>` | `agent.name`, `agent.source` (`model`/`rules`), `agent.ok`, `agent.rejected_count` |
| `provider.call` (client) | `provider.id`, `provider.capability`, `provider.operation`, `provider.status`, `provider.outcome`, `provider.local`, `provider.circuit_skipped`, `error.category`; **events**: `retry` (attempt, reason, delay), `retry_budget_exhausted`, `fallback` (from, to) |
| `llm.call` (client) | `llm.provider`, `llm.model`, `llm.task` (the schema's name), `llm.outcome`, `llm.usage.in`, `llm.usage.out` |
| `db.operation` (client) | `db.operation` (a method name). Only inside a trace. |

A cancelled call is not an error span (status unset, category `cancelled`); a call cut off by its stage's time is
`provider.local` and not an error either (it says nothing about the provider).

## Metrics

`GET /metrics` (Prometheus text). Every label is a closed list or a capped identifier; a value that is not identifier-
shaped is recorded as `invalid`, the 51st distinct provider as `other`, and a metric holds at most 1,000 series
(`packages/telemetry/src/metrics.ts`), so a bug cannot turn free text into time series.

| Metric | Type | Labels |
|---|---|---|
| `http_requests_total` | counter | method, route (pattern), status_class |
| `http_request_duration_seconds` | histogram | method, route |
| `http_errors_total` | counter | category, route |
| `planning_runs_total` | counter | event (`queued`, `started`, `succeeded`, `failed`, `cancelled`, `superseded`, `expired`), kind |
| `planning_duration_seconds` | histogram | kind, outcome |
| `planning_queue_wait_seconds` | histogram | kind |
| `planning_queue_depth` | gauge (read at scrape) | — |
| `planning_stage_duration_seconds` | histogram | stage |
| `agent_runs_total`, `agent_duration_seconds` | counter, histogram | agent, source (`model`/`rules`), outcome |
| `provider_calls_total` | counter | provider, capability, outcome (`ok`, `failed`, `timed_out`, `rate_limited`, `empty`, `unusable`, `not_available`, `skipped_circuit_open`) |
| `provider_call_duration_seconds` | histogram | provider, capability |
| `provider_errors_total` | counter | provider, capability, category |
| `provider_retries_total` | counter | provider, capability, reason (`network`, `timeout`, `server_error`) |
| `provider_fallbacks_total` | counter | capability, from, to |
| `provider_circuit_transitions_total` | counter | provider, capability, to |
| `provider_circuit_skips_total` | counter | provider, capability |
| `cache_events_total` | counter | operation, event (`hit`, `miss`, `store`, `invalid`, `error`) |
| `rate_limit_decisions_total` | counter | policy, decision (`allowed`, `rejected`) |
| `llm_calls_total`, `llm_call_duration_seconds` | counter, histogram | provider, task, outcome |
| `llm_tokens_total` | counter | provider, model, direction |
| `llm_cost_usd_total` | counter | provider, model (**only** from `LLM_PRICE_INPUT_PER_MTOK`/`LLM_PRICE_OUTPUT_PER_MTOK`; no built-in price list) |
| `db_operation_duration_seconds`, `db_slow_operations_total` | histogram, counter | operation, outcome |
| `errors_total` | counter | category, component |
| `knowledge_retrievals_total`, `knowledge_stage_duration_seconds` | counter, histogram | outcome; stage (Phase 8) |

Token counts are whatever the model provider reports; if it reports none, none are counted. A cost is an
estimate from the operator's own prices and is absent when they gave none.

A worker running without the API can serve its own `/live` and `/metrics` on `WORKER_METRICS_PORT` (with `OPS_TOKEN`), since
the planning metrics are recorded in the process that runs the search.

## Error taxonomy

One closed list, `ErrorCategory` (`packages/telemetry/src/errors.ts`), used identically in logs (`errorCategory`), metrics
(`category`), traces (`error.category`) and the `X-Error-Category` response header (the body is unchanged):

`validation` · `authentication` · `authorization` · `not_found` · `conflict` · `provider_unavailable` · `provider_timeout` ·
`provider_invalid_response` · `provider_rejected` · `rate_limited` · `dependency_unavailable` · `queue_overloaded` ·
`cancelled` · `unsupported` · `internal_error`

"Nothing found" is not an error category: it is an answer.

## Health, readiness, status

| Endpoint | Question | Depends on | Public |
|---|---|---|---|
| `GET /live` | Is this process alive? | nothing | yes; `{ status, uptimeSeconds }` |
| `GET /ready` | Can this instance accept work? | the database answers, the queue can be read, a place lookup is configured | yes; `{ ready, store, geocoding }` and fixed words on failure |
| `GET /health` | (kept) the store's state | the store | yes; no reason given |
| `GET /ops/status` | The operator's view | — | **token**: store, queue depth and capacity, Redis state (`not_configured`/`ok`/`degraded`), provider circuits, LLM, cache, telemetry, knowledge (enabled, namespace, embedder, document and quarantine counts, whether the embedder matches the index) |
| `GET /metrics` | Prometheus | — | **token** |

Readiness does **not** depend on an optional travel provider, Redis (limits and cache fall back to the process), the language
model, or the queue being full (turning searches away is this service doing its job; removing the instance would only move the
load). The container health check is `/live`, so an outage of the database or a provider can never restart the API. Both operator
endpoints answer 404 when `OPS_TOKEN` is not set, need `Authorization: Bearer …` (compared in constant time, never in the query
string), and lock an address out after 10 wrong tokens in 15 minutes.

## Telemetry data policy

Telemetry is a privacy and attack surface, so it is constrained in code, not by convention, and tested
(`observability.test.ts`: "holds no cookie, token, email address, address, or traveller's words in any span, metric or log line").

* **Never recorded:** prompts, model answers, request or response bodies, a traveller's words (change requests, requirements,
  free text), cookies, session or sign-in tokens, `Authorization` headers, API keys, email addresses, IP addresses (only the
  keyed tag), exception messages on spans (only `error.type` and `error.category`), arguments of a store call.
* **Span attributes** pass `safeAttributes`: primitives only, strings cut to 200 characters, and any attribute whose *name*
  says prompt, body, message, utterance, cookie, token, secret, password, authorization, api key, email, credential, answer
  is dropped whatever its value.
* **Metric labels** are closed lists or capped identifiers; free text becomes `invalid`/`other`.
* **Identifiers** (`requestId`, `runId`, `tripId`, trace ids) are random and validated.
* **Log errors** carry class, category and stack frames; messages only when configured.

## Finding the bottleneck

| Question | Where to look |
|---|---|
| Which provider is slow / failing? | `provider_call_duration_seconds`, `provider_calls_total{outcome}`, `provider_errors_total` by provider and capability |
| Is a provider being retried? | `provider_retries_total`, `retry` events on `provider.call` spans |
| Did a circuit open, and how often? | `provider_circuit_transitions_total{to="open"}`, `provider.circuit` log lines, `/ops/status` |
| Did fallback occur? | `provider_fallbacks_total`, `fallback` events |
| Which stage of planning is slow? | `planning_stage_duration_seconds` by stage; the `planning.stage` spans of one run |
| Which agent is slow? | `agent_duration_seconds`; `agent.*` spans |
| Is it the model? | `llm_call_duration_seconds`, `llm_calls_total{outcome}`, `llm.call` spans |
| Is it the database? | `db_operation_duration_seconds` by operation, `db_slow_operations_total`, `db.slow` log lines |
| Is it the queue? | `planning_queue_wait_seconds`, `planning_queue_depth`, `planning_runs_total{event="expired"}` |
| What happened to this one search? | its `runId` (or the `X-Request-Id` of the request that started it) in the logs, and its trace |
| Error / success rate | `http_requests_total` by status_class, `planning_runs_total` succeeded vs failed |
| How often are searches cancelled? | `planning_runs_total{event="cancelled"}` |

`packages/engine/scripts/measure-plan.ts` remains the way to measure the planner's shape offline (Phase 5).

## Recommended alerts

There is no alerting platform in this repository, and none is added. These are conditions worth alerting on, as PromQL
for Prometheus-compatible systems; **every threshold is a starting point to tune from real traffic, not a measured value**.

| Condition | PromQL (thresholds configurable) | Suggested severity |
|---|---|---|
| High API error rate | `sum(rate(http_requests_total{status_class="5xx"}[5m])) / sum(rate(http_requests_total[5m])) > 0.02` for 10m | page |
| Sustained latency | `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m]))) > 2` for 15m | ticket |
| Searches failing | `sum(rate(planning_runs_total{event="failed"}[15m])) / sum(rate(planning_runs_total{event="started"}[15m])) > 0.1` | page |
| Searches slow | `histogram_quantile(0.95, sum by (le) (rate(planning_duration_seconds_bucket{outcome="succeeded"}[15m]))) > 45` (the search deadline is 60 s) | ticket |
| Queue backlog | `planning_queue_depth > 0.5 * <MAX_QUEUED_RUNS>` for 5m; or `histogram_quantile(0.95, sum by (le) (rate(planning_queue_wait_seconds_bucket[10m]))) > 30` | page |
| Queue shedding | `increase(planning_runs_total{event="expired"}[15m]) > 0` | page |
| A provider failing | `sum by (provider, capability) (rate(provider_calls_total{outcome=~"failed|timed_out|unusable"}[10m])) / sum by (provider, capability) (rate(provider_calls_total[10m])) > 0.3` for 10m | ticket |
| Circuit repeatedly opening | `increase(provider_circuit_transitions_total{to="open"}[1h]) >= 3` per provider/capability | ticket |
| Database failing or slow | `sum(rate(errors_total{component="database"}[5m])) > 0`, or `histogram_quantile(0.95, sum by (le, operation) (rate(db_operation_duration_seconds_bucket[5m]))) > 0.5` | page |
| Redis failing | `sum(increase(errors_total{component="redis"}[10m])) > 0` (limits are per process meanwhile) | ticket |
| Language model failing | `sum(rate(llm_calls_total{outcome=~"failed|invalid_output"}[15m])) / sum(rate(llm_calls_total[15m])) > 0.2` | ticket |
| Rate limits rejecting a lot | `sum(rate(rate_limit_decisions_total{decision="rejected"}[10m])) / sum(rate(rate_limit_decisions_total[10m])) > 0.1` | look |
| Telemetry itself | `increase(telemetry_series_dropped_total[1h]) > 0` (a label is growing) | ticket |
| Knowledge answers failing | `sum(rate(knowledge_retrievals_total{outcome="error"}[10m])) > 0` (the index or the embedder is down; planning is unaffected) | ticket |
| Knowledge answers declining more | `sum(rate(knowledge_retrievals_total{outcome="insufficient"}[1h])) / sum(rate(knowledge_retrievals_total[1h])) > 0.6` (documents missing, or the embedder changed: check `/ops/status` `knowledge.embedderMatchesIndex`) | look |
| Knowledge answers slow | `histogram_quantile(0.95, sum by (le) (rate(knowledge_stage_duration_seconds_bucket{stage="total"}[15m]))) > 5` (an embedder or model network call) | ticket |

## Configuration

`TELEMETRY_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_SAMPLER_ARG`, `SERVICE_NAME`, `OPS_TOKEN` (≥ 24 characters),
`SLOW_DB_MS`, `LOG_ERROR_MESSAGES`, `WORKER_METRICS_PORT`, `LLM_PRICE_INPUT_PER_MTOK`, `LLM_PRICE_OUTPUT_PER_MTOK`. See `.env.example`.

## Not verified

No collector, Prometheus, Grafana or alerting system was used: the OTLP exporter is loaded only when configured and has never been
pointed at a real collector; the PromQL above was written against the metric definitions, not run against a Prometheus. What is
tested is what the code emits: spans (in-memory exporter), the Prometheus text (parsed as text), log lines (captured), and the
propagation between a request, its queued run and the worker.
