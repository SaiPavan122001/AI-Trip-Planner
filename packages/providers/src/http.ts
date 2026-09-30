import { ZodError } from 'zod';
import { RetryBudget, backoffDelayMs, fail, sleepUnlessAborted, type ProviderFailure } from '@trip/shared';
import { addSpanEvent, metrics } from '@trip/telemetry';
import { RequestLimitError, currentScope, spendRequest } from './call-scope.js';
import { checkOutboundUrl } from './ssrf.js';

/**
 * A small HTTP client with the behaviours every provider call needs: a hard
 * timeout per attempt, retries that are safe (and only then), a redirect rule
 * that cannot be used to reach somewhere else, and a per-provider request
 * pacer so a burst of parallel searches does not trip a vendor's rate limit.
 *
 * Retries, precisely:
 *  - Only transient failures: the connection failed, the attempt timed out, or
 *    the provider answered 408, 500, 502, 503 or 504. Never a 4xx (the request
 *    was wrong), never a 429 (the provider said to stop; the circuit breaker
 *    and the failure's `retryAfterSeconds` carry that), never a body that was
 *    not usable, never a cancellation.
 *  - Only requests that are safe to repeat: a GET by default. A POST is retried
 *    only if the caller asks for it and knows the endpoint is idempotent.
 *  - Bounded: a count, an exponentially growing and jittered delay with a
 *    ceiling, and the deadline of the call it belongs to. A retry that would
 *    not fit in the time left is not started, and each attempt is only given
 *    the time left.
 *  - Not a storm: retries come out of a per-host budget that refills only as
 *    requests are made, so a provider that is failing everything is not hit
 *    harder for it.
 */

export interface HttpOptions {
  /** How long one attempt may take. */
  timeoutMs?: number;
  /** Retries after the first attempt. Defaults to 2 for a GET and 0 for anything else. */
  retries?: number;
  /** No wait between attempts is longer than this. */
  maxRetryDelayMs?: number;
  headers?: Record<string, string>;
  /** Parsed and returned as-is; adapters do their own schema validation. */
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Form-encode the body instead of JSON (OAuth token endpoints want this). */
  form?: boolean;
  signal?: AbortSignal;
  /** Randomness for the retry jitter; tests pass a fixed one. */
  random?: () => number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

/** The caller stopped waiting (its AbortSignal fired). Never retried. */
export class RequestAbortedError extends Error {
  constructor(readonly url: string) {
    super(`Request to ${url} was cancelled`);
    this.name = 'RequestAbortedError';
  }
}

/**
 * The provider answered, but the body was not JSON. Not retried: asking again
 * for the same thing rarely turns text into JSON, and each retry costs quota.
 */
export class InvalidResponseError extends Error {
  constructor(
    readonly url: string,
    readonly detail: string = 'the response was not valid JSON',
  ) {
    super(`Response from ${url} could not be used: ${detail}`);
    this.name = 'InvalidResponseError';
  }
}

/** The provider tried to send the request somewhere this client will not go. Not retried. */
export class RedirectRefusedError extends InvalidResponseError {
  constructor(url: string, reason: string) {
    super(url, `it redirected the request, which was refused: ${reason}`);
    this.name = 'RedirectRefusedError';
  }
}

/** The request never got an answer (DNS, refused or reset connection). */
export class NetworkError extends Error {
  constructor(
    readonly url: string,
    readonly causeMessage: string,
  ) {
    super(`Request to ${url} failed: ${causeMessage}`);
    this.name = 'NetworkError';
  }
}

export class TimeoutError extends Error {
  constructor(readonly url: string, readonly timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/** Too many requests were already waiting for their turn for this one to be made in time. */
export class PacerBackpressureError extends Error {
  constructor(readonly waitingMs: number) {
    super(`Not sent: about ${waitingMs} ms of requests were already waiting.`);
    this.name = 'PacerBackpressureError';
  }
}

const DEFAULT_TIMEOUT_MS = 12_000;
/** Transient answers worth asking again for. 429 is deliberately absent. */
const RETRYABLE_STATUS = new Set([408, 500, 502, 503, 504]);
const DEFAULT_MAX_RETRY_DELAY_MS = 3_000;
const BASE_RETRY_DELAY_MS = 300;
/** A retry is not started unless at least this much of the deadline is left to make it in. */
const MIN_ATTEMPT_MS = 1_500;
const MAX_REDIRECTS = 3;
/** A response bigger than this is not read: nothing this planner asks for is that large. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Defaults an operator can change, once, at start-up (`configureHttp`). */
const defaults = { maxRetries: 2, maxRetryDelayMs: DEFAULT_MAX_RETRY_DELAY_MS };

export function configureHttp(next: { maxRetries?: number; maxRetryDelayMs?: number }): void {
  if (next.maxRetries !== undefined) defaults.maxRetries = Math.max(0, Math.floor(next.maxRetries));
  if (next.maxRetryDelayMs !== undefined) defaults.maxRetryDelayMs = Math.max(0, next.maxRetryDelayMs);
}

const retryBudgets = new Map<string, RetryBudget>();
const budgetFor = (origin: string): RetryBudget => {
  let budget = retryBudgets.get(origin);
  if (!budget) {
    budget = new RetryBudget();
    retryBudgets.set(origin, budget);
  }
  return budget;
};

/** For tests: forget what every host has earned or spent. */
export function resetRetryBudgets(): void {
  retryBudgets.clear();
}

function buildUrl(base: string, query: HttpOptions['query']): string {
  if (!query) return base;
  const url = new URL(base);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/**
 * Serialises requests per provider with a minimum gap between them. Nominatim,
 * for instance, requires at most one request per second; exceeding it gets the
 * whole deployment blocked rather than merely throttled.
 *
 * The line is bounded by time, not just by count: a request is turned away at
 * once if the requests ahead of it would use up more time than it has, and a
 * request whose caller has gone (cancelled, out of time) leaves the line
 * without waiting for its turn or being sent.
 */
export class RequestPacer {
  private queue: Promise<unknown> = Promise.resolve();
  private lastAt = 0;
  private waiting = 0;

  constructor(private readonly minIntervalMs: number) {}

  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const scope = currentScope();
    const stop = signal && scope ? AbortSignal.any([signal, scope.signal]) : (signal ?? scope?.signal);
    const projected = this.waiting * this.minIntervalMs;
    if (scope && projected > 0 && projected >= scope.deadline.remainingMs()) {
      return Promise.reject(new PacerBackpressureError(projected));
    }
    this.waiting += 1;
    const scheduled = this.queue.then(async () => {
      try {
        if (stop?.aborted) throw new RequestAbortedError('(waiting in line)');
        const wait = this.minIntervalMs - (Date.now() - this.lastAt);
        if (wait > 0 && !(await sleepUnlessAborted(wait, stop))) throw new RequestAbortedError('(waiting in line)');
        try {
          return await task();
        } finally {
          this.lastAt = Date.now();
        }
      } finally {
        this.waiting -= 1;
      }
    });
    // Keep the chain alive even when a task rejects.
    this.queue = scheduled.catch(() => undefined);
    return scheduled;
  }
}

async function readJson(res: Response, url: string): Promise<unknown> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new InvalidResponseError(url, 'the response was too large');
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) throw new InvalidResponseError(url, 'the response was too large');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidResponseError(url);
  }
}

/** One request/response, following no redirects; the caller decides about those. */
async function attemptOnce(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function httpJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    headers = {},
    method = 'GET',
    body,
    form = false,
    query,
    random = Math.random,
  } = opts;
  const retries = opts.retries ?? (method === 'GET' ? defaults.maxRetries : 0);
  const maxDelay = opts.maxRetryDelayMs ?? defaults.maxRetryDelayMs;

  const scope = currentScope();
  // Cancelled by whoever asked, or by the scope this call runs in.
  const signal =
    opts.signal && scope ? AbortSignal.any([opts.signal, scope.signal]) : (opts.signal ?? scope?.signal);
  const finalUrl = buildUrl(url, query);
  const origin = new URL(finalUrl).origin;
  const budget = budgetFor(origin);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw new RequestAbortedError(finalUrl);
    // What is left of the time this call may take, if it has been given a limit.
    const remaining = scope ? scope.deadline.remainingMs() : Number.POSITIVE_INFINITY;
    if (attempt > 0 && remaining < MIN_ATTEMPT_MS) break;
    const attemptMs = Math.max(1, Math.min(timeoutMs, remaining));
    spendRequest(scope);
    if (attempt === 0) budget.recordRequest();

    let delayBeforeRetry: number | null = null;
    try {
      const init: RequestInit = {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined
            ? {}
            : { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }),
          ...headers,
        },
      };
      if (body !== undefined) {
        init.body = form
          ? new URLSearchParams(body as Record<string, string>).toString()
          : JSON.stringify(body);
      }

      let res = await attemptOnce(finalUrl, init, attemptMs, signal);
      res = await followSameOriginRedirects(res, finalUrl, method, init, attemptMs, signal);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const retryAfter = Number(res.headers.get('retry-after'));
        const err = new HttpError(
          res.status,
          text.slice(0, 2000),
          finalUrl,
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
        );
        if (!RETRYABLE_STATUS.has(res.status)) throw err;
        lastError = err;
        delayBeforeRetry = backoffDelayMs(attempt, { baseMs: BASE_RETRY_DELAY_MS, maxDelayMs: maxDelay }, random);
      } else {
        if (res.status === 204) return undefined as T;
        try {
          return (await readJson(res, finalUrl)) as T;
        } catch (parseError) {
          // A body cut off by the deadline is a timeout, not bad data.
          if (parseError instanceof Error && parseError.name === 'AbortError') throw parseError;
          if (parseError instanceof InvalidResponseError) throw parseError;
          throw new InvalidResponseError(finalUrl);
        }
      }
    } catch (err) {
      if (err instanceof HttpError && delayBeforeRetry === null) throw err;
      if (err instanceof InvalidResponseError || err instanceof RequestLimitError) throw err;
      if (!(err instanceof HttpError)) {
        // Stopped by the caller, not by the timeout: waiting or trying again
        // would only spend a provider's quota on an answer nobody wants.
        if (signal?.aborted) throw new RequestAbortedError(finalUrl);
        const aborted = err instanceof Error && err.name === 'AbortError';
        lastError = aborted
          ? new TimeoutError(finalUrl, attemptMs)
          : new NetworkError(finalUrl, err instanceof Error ? err.message : String(err));
        delayBeforeRetry = backoffDelayMs(attempt, { baseMs: BASE_RETRY_DELAY_MS, maxDelayMs: maxDelay }, random);
      }
    }

    // Reached only when the attempt failed in a way that may be transient.
    if (attempt >= retries || delayBeforeRetry === null) break;
    // Not while the provider is already failing everything, and not if the wait
    // plus a worthwhile attempt would not fit in the time left.
    if (scope && scope.deadline.remainingMs() < delayBeforeRetry + MIN_ATTEMPT_MS) break;
    if (!budget.tryAcquire()) {
      addSpanEvent('retry_budget_exhausted', { attempt: attempt + 1 });
      break;
    }
    // A retry is worth seeing: it is a second request to a provider that already failed once.
    const reason = lastError instanceof HttpError ? 'server_error' : lastError instanceof TimeoutError ? 'timeout' : 'network';
    metrics.providerRetries.inc({ provider: scope?.call?.provider ?? 'unknown', capability: scope?.call?.capability ?? 'planner', reason });
    addSpanEvent('retry', { attempt: attempt + 1, reason, delay_ms: delayBeforeRetry });
    if (!(await sleepUnlessAborted(delayBeforeRetry, signal))) throw new RequestAbortedError(finalUrl);
  }
  throw lastError;
}

/**
 * Follows a redirect only to the same origin and over the same scheme, at most
 * a few times, and only for a GET. Anything else is refused: a provider (or
 * anything between us and it) that answers with a redirect to another host is
 * the classic way to make a server request something it should never reach,
 * and a redirect would also carry our credentials along.
 */
async function followSameOriginRedirects(
  first: Response,
  startUrl: string,
  method: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Response> {
  let res = first;
  let current = startUrl;
  for (let hops = 0; res.status >= 300 && res.status < 400 && res.status !== 304; hops += 1) {
    const location = res.headers.get('location');
    void res.body?.cancel().catch(() => undefined);
    if (method !== 'GET') throw new RedirectRefusedError(current, 'only a GET may be redirected');
    if (!location) throw new RedirectRefusedError(current, 'no destination was given');
    if (hops >= MAX_REDIRECTS) throw new RedirectRefusedError(current, 'too many redirects');
    let target: URL;
    try {
      target = new URL(location, current);
    } catch {
      throw new RedirectRefusedError(current, 'the destination was not a valid URL');
    }
    const from = new URL(current);
    if (target.origin !== from.origin) {
      // Never reachable from an operator-configured host to another one, and
      // never to a place the SSRF rules forbid. Say which, for the log.
      const verdict = checkOutboundUrl(target.toString());
      throw new RedirectRefusedError(current, verdict.ok ? 'it points at a different host' : verdict.reason);
    }
    current = target.toString();
    res = await attemptOnce(current, init, timeoutMs, signal);
  }
  return res;
}

/**
 * Converts a thrown transport error into the ProviderFailure the rest of the
 * system understands. Vendor error bodies never reach the traveller verbatim,
 * because they routinely leak internal identifiers and unhelpful jargon.
 */
export function toProviderFailure(
  err: unknown,
  provider: string,
  providerLabel: string,
): ProviderFailure {
  if (err instanceof RequestAbortedError) {
    return { ...fail('timeout', provider, providerLabel, 'The search was stopped before ' + providerLabel + ' answered.'), local: true };
  }
  if (err instanceof TimeoutError) {
    return fail('timeout', provider, providerLabel, `${providerLabel} did not respond in time.`);
  }
  if (err instanceof PacerBackpressureError) {
    return {
      ...fail(
        'timeout',
        provider,
        providerLabel,
        `${providerLabel} had too many requests waiting to be sent, so this one could not be made in time.`,
      ),
      local: true,
    };
  }
  if (err instanceof RequestLimitError) {
    return { ...fail('unavailable', provider, providerLabel, 'This search reached its limit on requests to travel providers, so the rest were not made.'), local: true };
  }
  if (err instanceof HttpError) {
    if (err.status === 429) {
      return fail(
        'rate_limited',
        provider,
        providerLabel,
        `${providerLabel} is rate limiting requests right now.`,
        err.retryAfterSeconds ?? 30,
      );
    }
    if (err.status === 400 || err.status === 422) {
      return fail(
        'invalid_request',
        provider,
        providerLabel,
        `${providerLabel} rejected the search parameters for this route.`,
      );
    }
    if (err.status === 401 || err.status === 403) {
      return fail(
        'not_configured',
        provider,
        providerLabel,
        `${providerLabel} rejected the configured credentials.`,
      );
    }
    return fail('unavailable', provider, providerLabel, `${providerLabel} returned an error.`);
  }
  if (err instanceof NetworkError) {
    return fail('unavailable', provider, providerLabel, `${providerLabel} could not be reached.`);
  }
  // The provider answered with something this planner cannot use: not JSON,
  // not the documented shape, or a shape the adapter's own code choked on.
  // All of it is discarded, and it is reported as such rather than as an
  // outage, because a retry will not help and someone should look at it.
  if (
    err instanceof InvalidResponseError ||
    err instanceof ZodError ||
    err instanceof TypeError ||
    err instanceof RangeError ||
    err instanceof SyntaxError
  ) {
    return fail(
      'invalid_response',
      provider,
      providerLabel,
      `${providerLabel} returned a response this planner could not use, so it was discarded.`,
    );
  }
  return fail('unavailable', provider, providerLabel, `${providerLabel} ran into an unexpected problem.`);
}
