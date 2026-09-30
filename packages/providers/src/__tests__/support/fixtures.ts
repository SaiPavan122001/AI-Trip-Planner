import { readFileSync } from 'node:fs';
import { vi } from 'vitest';

/**
 * Serving canned answers instead of the network.
 *
 * `serve` replaces the global `fetch`. A request to an address nobody said how
 * to answer fails the test loudly instead of going out to the internet, so a
 * provider test can never quietly depend on a live service.
 */

/** Reads a fixture from `../fixtures`. Returns a fresh copy each time, so a test can bend it. */
export function fixture<T = unknown>(name: string): T {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

/** How one request is answered. */
export type Reply =
  | { kind: 'json'; body: unknown; status?: number; headers?: Record<string, string> }
  | { kind: 'text'; body: string; status?: number; headers?: Record<string, string> }
  /** Never answers, and honours the caller's abort, as a hung provider does. */
  | { kind: 'hang' }
  /** The connection fails before any answer (DNS, refused, reset). */
  | { kind: 'network_error' };

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Reply => ({
  kind: 'json',
  body,
  status,
  headers,
});
export const text = (body: string, status = 200): Reply => ({ kind: 'text', body, status });
export const hang: Reply = { kind: 'hang' };
export const networkError: Reply = { kind: 'network_error' };

export interface SeenRequest {
  url: URL;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/** Path fragment (matched against `pathname`) to reply, or a function that decides per request. */
export type Routes = Record<string, Reply | ((req: SeenRequest) => Reply)>;

export function serve(routes: Routes): { requests: SeenRequest[] } {
  const requests: SeenRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => {
        headers[k] = v;
      });
      let body: unknown = init.body ?? null;
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch {
          /* form-encoded or plain text: keep as is */
        }
      }
      const seen: SeenRequest = { url, method: init.method ?? 'GET', body, headers };
      requests.push(seen);

      const key = Object.keys(routes).find((k) => url.pathname.includes(k));
      if (!key) throw new Error(`Unexpected request in a fixture test: ${seen.method} ${url.href}`);
      const route = routes[key]!;
      const reply = typeof route === 'function' ? route(seen) : route;

      switch (reply.kind) {
        case 'network_error':
          throw new TypeError('fetch failed');
        case 'hang':
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          });
        case 'text':
          return new Response(reply.body, { status: reply.status ?? 200, headers: reply.headers ?? {} });
        case 'json':
          return new Response(JSON.stringify(reply.body), {
            status: reply.status ?? 200,
            headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
          });
      }
    }),
  );
  return { requests };
}

/**
 * Runs a call to completion under fake timers, stepping the clock so retry
 * back-off and timeouts elapse without the test waiting for them.
 */
export async function settle<T>(promise: Promise<T>, stepMs = 1_000, maxSteps = 120): Promise<T> {
  let done = false;
  const tracked = promise.finally(() => {
    done = true;
  });
  // Avoid an unhandled rejection while the clock is being advanced.
  tracked.catch(() => undefined);
  for (let i = 0; i < maxSteps && !done; i += 1) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  return tracked;
}
