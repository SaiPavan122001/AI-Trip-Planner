import { ZodError } from 'zod';
import { fail, type ProviderFailure } from '@trip/shared';

/**
 * A small HTTP client with the three behaviours every provider call needs:
 * a hard timeout, bounded retries with jittered backoff on transient failures,
 * and a per-provider request pacer so a burst of parallel searches does not
 * trip a vendor's rate limit.
 */

export interface HttpOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  /** Parsed and returned as-is; adapters do their own schema validation. */
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Form-encode the body instead of JSON (OAuth token endpoints want this). */
  form?: boolean;
  signal?: AbortSignal;
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

const DEFAULT_TIMEOUT_MS = 12_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function buildUrl(base: string, query: HttpOptions['query']): string {
  if (!query) return base;
  const url = new URL(base);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Serialises requests per provider with a minimum gap between them. Nominatim,
 * for instance, requires at most one request per second; exceeding it gets the
 * whole deployment blocked rather than merely throttled.
 */
export class RequestPacer {
  private queue: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const scheduled = this.queue.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.lastAt);
      if (wait > 0) await sleep(wait);
      try {
        return await task();
      } finally {
        this.lastAt = Date.now();
      }
    });
    // Keep the chain alive even when a task rejects.
    this.queue = scheduled.catch(() => undefined);
    return scheduled;
  }
}

export async function httpJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 2,
    headers = {},
    method = 'GET',
    body,
    form = false,
    query,
    signal,
  } = opts;

  const finalUrl = buildUrl(url, query);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw new RequestAbortedError(finalUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const init: RequestInit = {
        method,
        signal: controller.signal,
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

      const res = await fetch(finalUrl, init);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const retryAfter = res.headers.get('retry-after');
        const err = new HttpError(
          res.status,
          text.slice(0, 2000),
          finalUrl,
          retryAfter ? Number(retryAfter) : null,
        );
        if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
          lastError = err;
          await sleep(backoffMs(attempt, err.retryAfterSeconds));
          continue;
        }
        throw err;
      }
      if (res.status === 204) return undefined as T;
      try {
        return (await res.json()) as T;
      } catch (parseError) {
        // A body cut off by the deadline is a timeout, not bad data.
        if (parseError instanceof Error && parseError.name === 'AbortError') throw parseError;
        throw new InvalidResponseError(finalUrl);
      }
    } catch (err) {
      if (err instanceof HttpError || err instanceof InvalidResponseError) throw err;
      // Stopped by the caller, not by the timeout: waiting or trying again
      // would only spend a provider's quota on an answer nobody wants.
      if (signal?.aborted) throw new RequestAbortedError(finalUrl);
      const aborted = err instanceof Error && err.name === 'AbortError';
      lastError = aborted
        ? new TimeoutError(finalUrl, timeoutMs)
        : new NetworkError(finalUrl, err instanceof Error ? err.message : String(err));
      if (attempt >= retries) break;
      await sleep(backoffMs(attempt, null));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastError;
}

function backoffMs(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) return Math.min(retryAfterSeconds * 1000, 10_000);
  const base = 300 * 2 ** attempt;
  return base + Math.random() * base * 0.4;
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
    return fail('timeout', provider, providerLabel, 'The search was stopped before ' + providerLabel + ' answered.');
  }
  if (err instanceof TimeoutError) {
    return fail('timeout', provider, providerLabel, `${providerLabel} did not respond in time.`);
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
