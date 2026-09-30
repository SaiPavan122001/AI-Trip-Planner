import { AsyncLocalStorage } from 'node:async_hooks';
import { Deadline, timedSignal, type TimedSignal } from '@trip/shared';

/**
 * What every provider call, and every HTTP request inside it, is answerable to:
 * a signal that fires on cancellation or when its time is up, the deadline
 * itself (so a retry can tell whether it still fits), and an allowance of
 * requests for the whole search.
 *
 * It travels with the call (AsyncLocalStorage), not through every adapter's
 * signature. That is deliberate. Cancellation used to reach a request only if
 * each adapter remembered to forward a `signal`, and two of them did not (the
 * transfer search and the place lookup), so cancelling a search left their
 * requests running. A scope makes "stop" and "you have this long" apply to
 * everything started inside it, whether or not the code that started it knows.
 */

export interface RequestAllowance {
  used: number;
  readonly max: number;
}

export interface CallScope {
  signal: AbortSignal;
  deadline: Deadline;
  /** Shared by everything in one search: how many HTTP requests it may still make. */
  requests?: RequestAllowance;
  /** Which provider and capability this call is for, so a retry or a request inside it can be attributed. */
  call?: { provider: string; capability: string };
}

const storage = new AsyncLocalStorage<CallScope>();

export function currentScope(): CallScope | undefined {
  return storage.getStore();
}

export function runInScope<T>(scope: CallScope, work: () => T): T {
  return storage.run(scope, work);
}

/** Raised when a search has used up the HTTP requests it was allowed. */
export class RequestLimitError extends Error {
  constructor(readonly max: number) {
    super(`This search reached its limit of ${max} provider requests.`);
    this.name = 'RequestLimitError';
  }
}

/** Counts one request against the scope's allowance; throws when there is none left. */
export function spendRequest(scope: CallScope | undefined): void {
  const allowance = scope?.requests;
  if (!allowance) return;
  if (allowance.used >= allowance.max) throw new RequestLimitError(allowance.max);
  allowance.used += 1;
}

export interface Budget {
  /** Cancellation from above (the search's own signal). */
  signal?: AbortSignal | undefined;
  /** How long this step may take, at most. It can only narrow the enclosing scope's time, never extend it. */
  ms: number;
  /** A ceiling on HTTP requests, shared with everything inside; the enclosing scope's allowance wins if it has one. */
  maxRequests?: number;
}

/**
 * Runs `work` with a time budget and cancellation that everything it starts
 * inherits. Time never widens: inside an enclosing scope the step gets no more
 * than that scope has left, so a stage cannot spend what the search still
 * needs. The timer is always released.
 */
export async function withBudget<T>(budget: Budget, work: () => Promise<T>): Promise<T> {
  const outer = currentScope();
  const ms = Math.max(0, Math.min(budget.ms, outer ? outer.deadline.remainingMs() : Number.POSITIVE_INFINITY));
  const parents = [budget.signal, outer?.signal].filter((s): s is AbortSignal => s !== undefined);
  const parent = parents.length > 1 ? AbortSignal.any(parents) : parents[0];
  const timed: TimedSignal = timedSignal(parent, ms);
  const requests: RequestAllowance | undefined =
    outer?.requests ?? (budget.maxRequests === undefined ? undefined : { used: 0, max: budget.maxRequests });
  const scope: CallScope = {
    signal: timed.signal,
    deadline: (outer?.deadline ?? Deadline.never()).within(ms),
    ...(requests ? { requests } : {}),
    ...(outer?.call ? { call: outer.call } : {}),
  };
  try {
    return await runInScope(scope, work);
  } finally {
    timed.dispose();
  }
}
