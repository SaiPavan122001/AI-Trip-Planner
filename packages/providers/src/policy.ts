import {
  CircuitBreaker,
  CircuitRegistry,
  Deadline,
  TimeBudgetExceeded,
  fail,
  forCapability,
  statusClass,
  timedSignal,
  type CircuitState,
  type ProviderFailure,
  type ProviderResult,
} from '@trip/shared';
import { categoryOfProviderStatus, markSpanError, metrics, withSpan } from '@trip/telemetry';
import { currentScope, runInScope, type CallScope } from './call-scope.js';
import type { ProviderCall, ProviderPolicy } from './guard.js';
import { toProviderFailure } from './http.js';

/**
 * The provider policy the registry uses: every provider call goes through
 * `execute`, and this is where the four things a call needs beyond its adapter
 * are decided, in one place and not spread over the code that calls providers.
 *
 *  1. Isolation. Whatever the provider does (throw, hang, answer nonsense) the
 *     caller gets a `ProviderResult`, never an exception.
 *  2. A time budget. The call gets the smaller of its own ceiling and what the
 *     enclosing step (a stage of the search, the search itself) has left, and
 *     a signal that fires when that is used up or the search is cancelled.
 *     Everything the call starts (its HTTP requests, their retries) inherits it.
 *  3. A circuit breaker per provider and capability. A provider that has failed
 *     several times in a row is not called again until its recovery time has
 *     passed, then one probe decides. It is asked about again *for that
 *     capability only*: Amadeus failing on hotels does not stop flights.
 *  4. Honesty. A skipped call says so, and says what the failure was that
 *     caused it, so the traveller is never shown a silence as "no results".
 *
 * Retries are not here: they belong to the HTTP request (where it is known
 * that repeating is safe), and doing them again at this level would multiply
 * them. Fallback between providers is where a capability has an alternative
 * (see `fallback.ts`).
 */

export interface ResilientPolicyOptions {
  /** The longest one call may take, in ms. Null means only what the enclosing scope allows. */
  deadlineMs: number | null;
  /** Null switches circuit breaking off. */
  circuit: { failureThreshold: number; recoveryTimeoutMs: number } | null;
  now?: () => number;
  /** Told about the changes an operator would want to see in a log. */
  onEvent?: (event: PolicyEvent) => void;
}

export type PolicyEvent =
  | { type: 'circuit'; key: string; from: CircuitState; to: CircuitState }
  | { type: 'skipped'; key: string; retryAfterMs: number }
  | { type: 'failed'; key: string; status: ProviderFailure['status']; local: boolean };

/** `provider:capability` back into its two parts. */
function splitKey(key: string): [string, string] {
  const at = key.lastIndexOf(':');
  return at < 0 ? [key, 'planner'] : [key.slice(0, at), key.slice(at + 1)];
}

/** Answers that mean the provider is working, even though it had nothing for us. */
const HEALTHY_STATUSES = new Set(['no_availability', 'unsupported_route', 'unsupported_capability']);
/** Answers that count against the provider's health. */
const UNHEALTHY_STATUSES = new Set(['unavailable', 'timeout', 'invalid_response']);

export class ResilientPolicy implements ProviderPolicy {
  private readonly circuits: CircuitRegistry | null;
  private readonly lastFailure = new Map<string, ProviderFailure>();
  private readonly now: () => number;

  constructor(private readonly options: ResilientPolicyOptions) {
    this.now = options.now ?? Date.now;
    const circuit = options.circuit;
    this.circuits = circuit
      ? new CircuitRegistry(
          (key) =>
            new CircuitBreaker({
              failureThreshold: circuit.failureThreshold,
              recoveryTimeoutMs: circuit.recoveryTimeoutMs,
              now: this.now,
              onStateChange: (from, to) => {
                const [provider = key, capability = 'planner'] = splitKey(key);
                metrics.circuitTransitions.inc({ provider, capability, to });
                options.onEvent?.({ type: 'circuit', key, from, to });
              },
            }),
        )
      : null;
  }

  /** For diagnostics and tests: every circuit that has been used, and its state. */
  circuitStates(): Array<{ key: string; state: CircuitState; consecutiveFailures: number }> {
    return this.circuits?.snapshot() ?? [];
  }

  /**
   * Every provider call is one span (`provider.call`) and one set of metrics:
   * how it ended, how long it took, and which failure category it was. What
   * is recorded is the provider, the capability, the operation name and the
   * outcome; never what was asked or answered.
   */
  async execute<T>(call: ProviderCall, run: () => Promise<ProviderResult<T>>): Promise<ProviderResult<T>> {
    const started = performance.now();
    return withSpan(
      'provider.call',
      { 'provider.id': call.provider, 'provider.capability': call.capability, 'provider.operation': call.operation },
      async (span) => {
        const { result, skipped } = await this.attempt(call, run);
        const seconds = (performance.now() - started) / 1000;
        const outcome = skipped ? 'skipped_circuit_open' : statusClass(result.status);
        const category = categoryOfProviderStatus(result.status);
        const labels = { provider: call.provider, capability: call.capability };
        metrics.providerCalls.inc({ ...labels, outcome: outcome === 'ok' ? 'ok' : outcome });
        metrics.providerDuration.observe(labels, seconds);
        if (skipped) metrics.circuitSkips.inc(labels);
        if (category) metrics.providerErrors.inc({ ...labels, category });
        span.setAttribute('provider.status', result.status);
        span.setAttribute('provider.outcome', outcome);
        if (skipped) span.setAttribute('provider.circuit_skipped', true);
        if (result.status !== 'ok') {
          if (result.local) span.setAttribute('provider.local', true);
          if (category) markSpanError(span, category, result.local === true);
        }
        return result;
      },
      { kind: 'client' },
    );
  }

  private async attempt<T>(
    call: ProviderCall,
    run: () => Promise<ProviderResult<T>>,
  ): Promise<{ result: ProviderResult<T>; skipped: boolean }> {
    const key = `${call.provider}:${call.capability}`;
    const breaker = this.circuits?.get(key);
    const decision = breaker?.tryAcquire();
    if (decision && !decision.allowed) {
      this.options.onEvent?.({ type: 'skipped', key, retryAfterMs: decision.retryAfterMs });
      return { result: forCapability(this.skipped(call, key, decision.retryAfterMs), call.capability), skipped: true };
    }
    const permit = decision?.allowed ? decision.permit : null;

    const outer = currentScope();
    const ceiling = this.options.deadlineMs ?? Number.POSITIVE_INFINITY;
    const outerLeft = outer ? outer.deadline.remainingMs() : Number.POSITIVE_INFINITY;
    const budgetMs = Math.min(ceiling, outerLeft);
    // The call's own ceiling was not what limited it: an enclosing step's time
    // was. Being cut short by that says nothing about the provider.
    const truncated = outerLeft < ceiling;
    const timed = timedSignal(outer?.signal, budgetMs);
    const scope: CallScope = {
      signal: timed.signal,
      deadline: (outer?.deadline ?? Deadline.never(this.now)).within(budgetMs),
      ...(outer?.requests ? { requests: outer.requests } : {}),
      call: { provider: call.provider, capability: call.capability },
    };

    let result: ProviderResult<T>;
    try {
      const attempt = runInScope(scope, run).then(
        (r) => r,
        (err: unknown) => toProviderFailure(err, call.provider, call.providerLabel),
      );
      const stopped = new Promise<ProviderFailure>((resolve) => {
        const fire = () => resolve(this.stoppedFailure(call, timed.signal, budgetMs, timed.timedOut()));
        if (timed.signal.aborted) fire();
        else timed.signal.addEventListener('abort', fire, { once: true });
      });
      result = await Promise.race([attempt, stopped]);
    } catch (err) {
      // `run` threw before returning a promise.
      result = toProviderFailure(err, call.provider, call.providerLabel);
    } finally {
      timed.dispose();
    }

    // Decided by what happened, not by which of the two racing promises got
    // there first: a call that was stopped is reported as stopped.
    if (result.status === 'timeout' && timed.signal.aborted) {
      result = this.stoppedFailure(call, timed.signal, budgetMs, timed.timedOut());
    }

    if (permit && breaker) this.report(key, breaker, permit, result, { truncated });
    return { result: result.status === 'ok' ? result : forCapability(result, call.capability), skipped: false };
  }

  private stoppedFailure(call: ProviderCall, signal: AbortSignal, budgetMs: number, ownTimeout: boolean): ProviderFailure {
    const seconds = Math.max(1, Math.round(budgetMs / 1000));
    if (ownTimeout) {
      return fail('timeout', call.provider, call.providerLabel, `${call.providerLabel} did not answer within ${seconds} seconds.`);
    }
    if (signal.reason instanceof TimeBudgetExceeded) {
      // An enclosing step ran out of time: this provider was cut off, not asked to hurry.
      return {
        ...fail('timeout', call.provider, call.providerLabel, `${call.providerLabel} did not answer in the time this step of the search could allow.`),
        local: true,
      };
    }
    return { ...fail('timeout', call.provider, call.providerLabel, `The search was stopped before ${call.providerLabel} answered.`), local: true };
  }

  private skipped(call: ProviderCall, key: string, retryAfterMs: number): ProviderFailure {
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    const earlier = this.lastFailure.get(key);
    const because = earlier ? ` Its last failure was: ${earlier.message}` : '';
    return {
      ...fail(
        'unavailable',
        call.provider,
        call.providerLabel,
        `${call.providerLabel} was not asked, because it has been failing and is being given time to recover (it will be tried again in about ${seconds} seconds).${because}`,
        seconds,
      ),
      local: true,
    };
  }

  private report(
    key: string,
    breaker: CircuitBreaker,
    permit: { success(): void; failure(): void; ignore(): void },
    result: ProviderResult<unknown>,
    context: { truncated: boolean },
  ): void {
    if (result.status === 'ok' || HEALTHY_STATUSES.has(result.status)) {
      permit.success();
      return;
    }
    this.lastFailure.set(key, result);
    const local = result.local === true || (result.status === 'timeout' && context.truncated);
    this.options.onEvent?.({ type: 'failed', key, status: result.status, local });
    if (local) {
      permit.ignore();
      return;
    }
    if (result.status === 'rate_limited') {
      // The provider said to stop for a while; honour that instead of counting it as an outage.
      permit.ignore();
      breaker.trip(Math.min(Math.max(result.retryAfterSeconds ?? 30, 1), 300) * 1000);
      return;
    }
    if (UNHEALTHY_STATUSES.has(result.status)) {
      permit.failure();
      return;
    }
    // Rejected credentials, a request the provider refused as malformed, and the
    // like: not signs of an unhealthy provider, and calling again will not help.
    permit.ignore();
  }
}
