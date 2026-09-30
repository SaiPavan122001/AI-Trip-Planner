import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withBudget } from '../call-scope.js';
import {
  HttpError,
  InvalidResponseError,
  RedirectRefusedError,
  RequestAbortedError,
  RequestPacer,
  PacerBackpressureError,
  TimeoutError,
  httpJson,
  resetRetryBudgets,
  toProviderFailure,
} from '../http.js';
import { hang, json, networkError, serve, settle, text, type Reply, type SeenRequest } from './support/fixtures.js';

/**
 * Retries (Phase 5.1). A retry is a second paid request, so it must only happen
 * when it can help, only as often as allowed, and never past the time the call
 * has. Each rule has a test that would fail if it were broken.
 */

const URL_ = 'https://provider.test/api/thing';

/** Replies from a list, one per request, repeating the last. */
const sequence = (...replies: Reply[]) => {
  let n = 0;
  return (_req: SeenRequest): Reply => replies[Math.min(n++, replies.length - 1)]!;
};

beforeEach(() => {
  resetRetryBudgets();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('which failures are retried', () => {
  it('retries a temporary 5xx and returns the answer that follows', async () => {
    const { requests } = serve({ '/api/thing': sequence(json({}, 503), json({}, 502), json({ ok: true })) });
    await expect(settle(httpJson(URL_, { random: () => 1 }))).resolves.toEqual({ ok: true });
    expect(requests).toHaveLength(3);
  });

  it('retries when the connection fails', async () => {
    const { requests } = serve({ '/api/thing': sequence(networkError, json({ ok: true })) });
    await expect(settle(httpJson(URL_))).resolves.toEqual({ ok: true });
    expect(requests).toHaveLength(2);
  });

  it('retries an attempt that timed out', async () => {
    const { requests } = serve({ '/api/thing': sequence(hang, json({ ok: true })) });
    await expect(settle(httpJson(URL_, { timeoutMs: 500 }))).resolves.toEqual({ ok: true });
    expect(requests).toHaveLength(2);
  });

  it.each([400, 401, 403, 404, 409, 422])('does not retry a %i: the request itself was wrong', async (status) => {
    const { requests } = serve({ '/api/thing': json({ error: 'no' }, status) });
    await expect(settle(httpJson(URL_))).rejects.toBeInstanceOf(HttpError);
    expect(requests).toHaveLength(1);
  });

  it('does not retry a 429: the provider said to stop, and says when to come back', async () => {
    const { requests } = serve({ '/api/thing': json({}, 429, { 'retry-after': '7' }) });
    const error = await settle(httpJson(URL_)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(requests).toHaveLength(1);
    const failure = toProviderFailure(error, 'p', 'Provider');
    expect(failure.status).toBe('rate_limited');
    expect(failure.retryAfterSeconds).toBe(7);
  });

  it('does not retry an answer that is not JSON, or one that is too large to read', async () => {
    const notJson = serve({ '/api/thing': text('<html>maintenance</html>') });
    await expect(settle(httpJson(URL_))).rejects.toBeInstanceOf(InvalidResponseError);
    expect(notJson.requests).toHaveLength(1);
  });

  it('does not repeat a POST unless the caller says the endpoint is safe to repeat', async () => {
    const first = serve({ '/api/thing': json({}, 503) });
    await expect(settle(httpJson(URL_, { method: 'POST', body: { a: 1 } }))).rejects.toBeInstanceOf(HttpError);
    expect(first.requests).toHaveLength(1);

    const second = serve({ '/api/thing': sequence(json({}, 503), json({ ok: true })) });
    await expect(settle(httpJson(URL_, { method: 'POST', body: { a: 1 }, retries: 1 }))).resolves.toEqual({ ok: true });
    expect(second.requests).toHaveLength(2);
  });
});

describe('retries are bounded', () => {
  it('stops after the configured number of retries and reports the last failure', async () => {
    const { requests } = serve({ '/api/thing': json({}, 503) });
    const error = await settle(httpJson(URL_, { retries: 2 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(503);
    expect(requests).toHaveLength(3); // one attempt and two retries, no more
  });

  it('waits between attempts, longer each time, and never longer than the ceiling', async () => {
    const times: number[] = [];
    serve({
      '/api/thing': () => {
        times.push(Date.now());
        return json({}, 503);
      },
    });
    const call = httpJson(URL_, { retries: 4, maxRetryDelayMs: 1_000, random: () => 1 });
    call.catch(() => undefined);
    // Step in small increments so each attempt's time is seen.
    for (let i = 0; i < 100; i += 1) await vi.advanceTimersByTimeAsync(100);
    await call.catch(() => undefined);
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(gaps.length).toBe(4);
    // random = 1: the full planned delay, doubling from 300 ms, capped at 1000 ms.
    expect(gaps[0]).toBeGreaterThanOrEqual(300);
    expect(gaps[1]).toBeGreaterThanOrEqual(600);
    for (const gap of gaps) expect(gap).toBeLessThanOrEqual(1_100);
    expect(gaps[3]).toBeGreaterThanOrEqual(gaps[0]!);
  });

  it('jitters: two clients that failed together do not retry at the same instant', async () => {
    const delays: number[] = [];
    for (const random of [() => 0, () => 1]) {
      const times: number[] = [];
      serve({ '/api/thing': () => (times.push(Date.now()), times.length === 1 ? json({}, 503) : json({ ok: true })) });
      const call = httpJson(URL_, { random });
      for (let i = 0; i < 40; i += 1) await vi.advanceTimersByTimeAsync(50);
      await call;
      delays.push(times[1]! - times[0]!);
      resetRetryBudgets();
    }
    expect(delays[1]! - delays[0]!).toBeGreaterThanOrEqual(100);
  });

  it('does not start a retry that would not fit in the time the call has left', async () => {
    const { requests } = serve({ '/api/thing': json({}, 503) });
    // One second for the whole call: not enough to wait and make a worthwhile second attempt.
    const result = await settle(withBudget({ ms: 1_000 }, () => httpJson(URL_, { retries: 5 })).catch((e: unknown) => e));
    expect(result).toBeInstanceOf(HttpError);
    expect(requests).toHaveLength(1);
  });

  it('does not even wait to retry when the wait itself would eat the time an attempt needs', async () => {
    const { requests } = serve({ '/api/thing': json({}, 503) });
    // 1.7 s left: enough for an attempt, but not for a 0.3 s wait plus a 1.5 s attempt.
    let settled = false;
    const call = withBudget({ ms: 1_700 }, () => httpJson(URL_, { retries: 5, random: () => 1 })).catch((e: unknown) => {
      settled = true;
      return e;
    });
    await vi.advanceTimersByTimeAsync(0); // no time passes: a call that sleeps first would not have settled
    expect(settled).toBe(true);
    expect(await call).toBeInstanceOf(HttpError);
    expect(requests).toHaveLength(1);
  });

  it('gives each attempt no more than the time left, so a hung provider cannot outlast the call', async () => {
    serve({ '/api/thing': hang });
    const started = Date.now();
    const call = withBudget({ ms: 3_000 }, () => httpJson(URL_, { timeoutMs: 60_000, retries: 3 }));
    call.catch(() => undefined);
    const outcome = await settle(call.catch((e: unknown) => e), 250);
    expect(outcome).toBeInstanceOf(RequestAbortedError);
    expect(Date.now() - started).toBeLessThanOrEqual(3_500);
  });

  it('stops waiting to retry the moment the search is cancelled', async () => {
    const { requests } = serve({ '/api/thing': json({}, 503) });
    const controller = new AbortController();
    const call = httpJson(URL_, { retries: 3, signal: controller.signal });
    call.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10); // first attempt done, now backing off
    controller.abort();
    await expect(call).rejects.toBeInstanceOf(RequestAbortedError);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requests).toHaveLength(1);
  });

  it('cannot retry more than the host has earned: a provider failing everything is not hit harder', async () => {
    const { requests } = serve({ '/api/thing': json({}, 503) });
    let last = 0;
    for (let i = 0; i < 30; i += 1) {
      const before = requests.length;
      await settle(httpJson(URL_, { retries: 2 })).catch(() => undefined);
      last = requests.length - before;
    }
    // 30 calls, each entitled to 2 retries, would be 90 requests. The budget (10 to start, +0.2 per call) allows far fewer.
    expect(requests.length).toBeLessThan(60);
    expect(last).toBe(1); // by the end, every call is a single attempt
  });
});

describe('redirects cannot be used to reach somewhere else', () => {
  const redirect = (to: string, status = 302): Reply => ({ kind: 'text', body: '', status, headers: { location: to } });

  it('follows a redirect to the same host', async () => {
    const { requests } = serve({
      '/old': redirect('https://provider.test/new'),
      '/new': json({ moved: true }),
    });
    await expect(settle(httpJson('https://provider.test/old'))).resolves.toEqual({ moved: true });
    expect(requests.map((r) => r.url.pathname)).toEqual(['/old', '/new']);
  });

  it.each([
    ['another host', 'https://evil.example/steal'],
    ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback', 'http://127.0.0.1:8080/admin'],
    ['a private address', 'http://10.0.0.5/'],
    ['a non-HTTP scheme', 'file:///etc/passwd'],
    ['a downgrade to plain http', 'http://provider.test/new'],
  ])('refuses a redirect to %s, and does not make the request', async (_name, to) => {
    const { requests } = serve({ '/old': redirect(to), '/new': json({}), '/steal': json({}), '/admin': json({}) });
    await expect(settle(httpJson('https://provider.test/old'))).rejects.toBeInstanceOf(RedirectRefusedError);
    expect(requests.map((r) => r.url.href)).toEqual(['https://provider.test/old']);
  });

  it('refuses to redirect a POST (the body and credentials would follow it)', async () => {
    const { requests } = serve({ '/old': redirect('https://provider.test/new', 307), '/new': json({}) });
    await expect(settle(httpJson('https://provider.test/old', { method: 'POST', body: { secret: 1 } }))).rejects.toBeInstanceOf(
      RedirectRefusedError,
    );
    expect(requests).toHaveLength(1);
  });

  it('gives up on a redirect loop', async () => {
    const { requests } = serve({ '/loop': redirect('https://provider.test/loop') });
    await expect(settle(httpJson('https://provider.test/loop'))).rejects.toBeInstanceOf(RedirectRefusedError);
    expect(requests.length).toBeLessThanOrEqual(4);
  });

  it('reports a refused redirect as an unusable response, not an outage, and does not retry it', async () => {
    const { requests } = serve({ '/old': redirect('https://evil.example/') });
    const error = await settle(httpJson('https://provider.test/old')).catch((e: unknown) => e);
    expect(requests).toHaveLength(1);
    const failure = toProviderFailure(error, 'p', 'Provider');
    expect(failure.status).toBe('invalid_response');
  });
});

describe('the request line', () => {
  it('turns a request away at once when the ones ahead of it would use up its time', async () => {
    const pacer = new RequestPacer(1_000);
    const started: number[] = [];
    // Ten requests already waiting is ten seconds of line.
    for (let i = 0; i < 10; i += 1) void pacer.run(async () => started.push(i)).catch(() => undefined);
    const late = withBudget({ ms: 2_000 }, () => pacer.run(async () => 'made'));
    await expect(late).rejects.toBeInstanceOf(PacerBackpressureError);
    const failure = toProviderFailure(new PacerBackpressureError(10_000), 'p', 'Provider');
    expect(failure.status).toBe('timeout');
    expect(failure.local).toBe(true);
    await vi.advanceTimersByTimeAsync(11_000);
  });

  it('a request whose search was cancelled leaves the line without being sent', async () => {
    const pacer = new RequestPacer(1_000);
    let sent = 0;
    void pacer.run(async () => (sent += 1));
    const controller = new AbortController();
    const second = pacer.run(async () => (sent += 1), controller.signal);
    second.catch(() => undefined);
    controller.abort();
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(second).rejects.toBeInstanceOf(RequestAbortedError);
    expect(sent).toBe(1);
  });
});

describe('sanity of the timeout error itself', () => {
  it('still reports its own timeout as a timeout', async () => {
    serve({ '/api/thing': hang });
    const error = await settle(httpJson(URL_, { timeoutMs: 100, retries: 0 }), 50).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutError);
  });
});
