import { ERROR_CATEGORIES } from './errors.js';
import { MetricsRegistry, type LabelSpec } from './metrics.js';

/**
 * Every metric this system exposes, defined in one place.
 *
 * Names follow the Prometheus conventions (`_total` for counters, `_seconds`
 * for durations). Every label is either a closed list declared here or an
 * identifier from configuration with a cap (a provider id, a route pattern);
 * none is ever free text. Adding a metric means adding it here, which is also
 * where a reviewer checks its labels.
 *
 * There is one default registry per process (`registry`), because the code that
 * records (an adapter, the HTTP client, the model wrapper) has no place to be
 * handed one. Tests read it with `registry.value(...)` and clear it with
 * `resetMetrics()`.
 */

const closed = (name: string, allowed: readonly string[]): LabelSpec => ({ name, allowed });
const open = (name: string, maxValues = 50): LabelSpec => ({ name, maxValues });

const METHOD = closed('method', ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
const STATUS_CLASS = closed('status_class', ['2xx', '3xx', '4xx', '5xx']);
const CATEGORY = closed('category', ERROR_CATEGORIES);
const PROVIDER = open('provider', 40);
const CAPABILITY = closed('capability', ['geocoding', 'flights', 'hotels', 'trains', 'buses', 'self_drive', 'transfers', 'activities', 'routing', 'planner']);
const RUN_KIND = closed('kind', ['plan', 'replan']);
const PROVIDER_OUTCOME = closed('outcome', ['ok', 'failed', 'timed_out', 'rate_limited', 'empty', 'unusable', 'not_available', 'skipped_circuit_open']);

export const registry = new MetricsRegistry();

export const metrics = {
  // ---------------------------------------------------------------- HTTP
  httpRequests: registry.counter('http_requests_total', 'HTTP requests answered, by route pattern and status class.', [METHOD, open('route', 100), STATUS_CLASS]),
  httpDuration: registry.histogram('http_request_duration_seconds', 'HTTP request latency, by route pattern.', [METHOD, open('route', 100)]),
  httpErrors: registry.counter('http_errors_total', 'HTTP error answers, by operational category.', [CATEGORY, open('route', 100)]),

  // ------------------------------------------------------------ planning
  runs: registry.counter('planning_runs_total', 'Planning run lifecycle events.', [
    closed('event', ['started', 'succeeded', 'failed', 'cancelled', 'superseded', 'queued', 'expired']),
    RUN_KIND,
  ]),
  runDuration: registry.histogram('planning_duration_seconds', 'Time a planning run took, from start to finish.', [RUN_KIND, closed('outcome', ['succeeded', 'failed', 'cancelled', 'superseded'])]),
  runQueueWait: registry.histogram('planning_queue_wait_seconds', 'Time a planning run waited for a worker.', [RUN_KIND]),
  queueDepth: registry.gauge('planning_queue_depth', 'Planning runs waiting for a worker.'),
  stageDuration: registry.histogram('planning_stage_duration_seconds', 'Time each stage of a planning run took.', [
    closed('stage', ['guidance', 'search', 'hotels', 'assemble', 'plan_search', 'validation', 'synthesis']),
  ]),
  agentRuns: registry.counter('agent_runs_total', 'Planning agent runs, by who answered (model or rules).', [
    open('agent', 20),
    closed('source', ['model', 'rules', 'none']),
    closed('outcome', ['ok', 'failed']),
  ]),
  agentDuration: registry.histogram('agent_duration_seconds', 'Planning agent latency.', [open('agent', 20), closed('source', ['model', 'rules', 'none'])]),

  // ----------------------------------------------------------- providers
  providerCalls: registry.counter('provider_calls_total', 'Provider calls, by how they ended.', [PROVIDER, CAPABILITY, PROVIDER_OUTCOME]),
  providerDuration: registry.histogram('provider_call_duration_seconds', 'Provider call latency (retries included).', [PROVIDER, CAPABILITY]),
  providerErrors: registry.counter('provider_errors_total', 'Provider failures, by operational category.', [PROVIDER, CAPABILITY, CATEGORY]),
  providerRetries: registry.counter('provider_retries_total', 'Retried HTTP attempts to a provider.', [PROVIDER, CAPABILITY, closed('reason', ['network', 'timeout', 'server_error'])]),
  providerFallbacks: registry.counter('provider_fallbacks_total', 'Answers that came from a fallback provider.', [CAPABILITY, open('from', 40), open('to', 40)]),
  circuitTransitions: registry.counter('provider_circuit_transitions_total', 'Circuit breaker state changes.', [PROVIDER, CAPABILITY, closed('to', ['open', 'half_open', 'closed'])]),
  circuitSkips: registry.counter('provider_circuit_skips_total', 'Provider calls not made because the circuit was open.', [PROVIDER, CAPABILITY]),

  // --------------------------------------------------------------- cache
  cacheEvents: registry.counter('cache_events_total', 'Cache lookups and writes.', [open('operation', 20), closed('event', ['hit', 'miss', 'store', 'invalid', 'error'])]),

  // ---------------------------------------------------------- rate limit
  rateLimitDecisions: registry.counter('rate_limit_decisions_total', 'Requests accepted or rejected by a rate limit.', [open('policy', 30), closed('decision', ['allowed', 'rejected'])]),

  // ----------------------------------------------------------------- LLM
  llmCalls: registry.counter('llm_calls_total', 'Language-model calls, by task and how they ended.', [
    open('provider', 10),
    open('task', 20),
    closed('outcome', ['ok', 'failed', 'invalid_output', 'skipped_circuit_open', 'cancelled']),
  ]),
  llmDuration: registry.histogram('llm_call_duration_seconds', 'Language-model call latency.', [open('provider', 10), open('task', 20)]),
  llmTokens: registry.counter('llm_tokens_total', 'Language-model tokens, as reported by the provider.', [open('provider', 10), open('model', 20), closed('direction', ['input', 'output', 'cached_input'])]),
  llmCost: registry.counter('llm_cost_usd_total', 'Estimated language-model spend in US dollars, from the operator-configured prices only.', [open('provider', 10), open('model', 20)]),

  // ------------------------------------------------------------ database
  dbDuration: registry.histogram('db_operation_duration_seconds', 'Store operation latency, by operation name.', [open('operation', 80), closed('outcome', ['ok', 'error'])], [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]),
  dbSlow: registry.counter('db_slow_operations_total', 'Store operations slower than the configured threshold.', [open('operation', 80)]),

  // -------------------------------------------------------------- errors
  errors: registry.counter('errors_total', 'Operational errors, by category and the component that saw them.', [CATEGORY, open('component', 20)]),

  // ------------------------------------------------------------ knowledge
  knowledgeRetrievals: registry.counter('knowledge_retrievals_total', 'Knowledge retrievals, by how they ended.', [closed('outcome', ['answered', 'insufficient', 'error', 'disabled'])]),
  knowledgeDuration: registry.histogram('knowledge_stage_duration_seconds', 'Time each stage of a knowledge answer took.', [closed('stage', ['embed', 'retrieve', 'generate', 'verify', 'total'])]),
} as const;

/** Clears every recorded value. Definitions stay. For tests. */
export function resetMetrics(): void {
  registry.reset();
}

/** The HTTP status class of a status code. */
export function statusClassOf(status: number): '2xx' | '3xx' | '4xx' | '5xx' {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}
