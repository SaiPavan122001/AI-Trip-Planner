import { describe, expect, it, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitRegistry,
  Deadline,
  MemoryCache,
  RetryBudget,
  SingleFlight,
  TimeBudgetExceeded,
  TtlCache,
  backoffDelayMs,
  sleepUnlessAborted,
  timedSignal,
  type CircuitState,
} from '../resilience.js';

/** A clock the test moves by hand. */
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('Deadline', () => {
  it('counts down from the clock and never goes negative', () => {
    const c = clock();
    const d = Deadline.after(1000, c.now);
    expect(d.remainingMs()).toBe(1000);
    c.advance(400);
    expect(d.remainingMs()).toBe(600);
    c.advance(10_000);
    expect(d.remainingMs()).toBe(0);
    expect(d.expired).toBe(true);
  });

  it('can be narrowed but never widened', () => {
    const c = clock();
    const d = Deadline.after(1000, c.now);
    expect(d.within(300).remainingMs()).toBe(300);
    expect(d.within(5000).remainingMs()).toBe(1000);
  });

  it('leaves a reserve for the stages that come after', () => {
    const c = clock();
    const d = Deadline.after(60_000, c.now);
    expect(d.leaving(15_000).remainingMs()).toBe(45_000);
    expect(d.leaving(15_000, 20_000).remainingMs()).toBe(20_000);
    c.advance(50_000);
    // Less left than the reserve: the stage gets nothing rather than eating into it.
    expect(d.leaving(15_000).remainingMs()).toBe(0);
  });

  it('gives a share of what remains, within bounds', () => {
    const c = clock();
    const d = Deadline.after(10_000, c.now);
    expect(d.share(0.5).remainingMs()).toBe(5000);
    expect(d.share(0.01, 2000).remainingMs()).toBe(2000);
    expect(d.share(0.9, 0, 3000).remainingMs()).toBe(3000);
  });

  it('has a deadline that never comes', () => {
    const d = Deadline.never();
    expect(d.remainingMs()).toBe(Number.POSITIVE_INFINITY);
    expect(d.within(500).remainingMs()).toBeLessThanOrEqual(500);
  });
});

describe('timedSignal and sleepUnlessAborted', () => {
  it('fires when the time runs out and says so', () => {
    vi.useFakeTimers();
    try {
      const t = timedSignal(undefined, 1000);
      expect(t.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1000);
      expect(t.signal.aborted).toBe(true);
      expect(t.timedOut()).toBe(true);
      expect(t.signal.reason).toBeInstanceOf(TimeBudgetExceeded);
      t.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows its parent, and does not call that a timeout', () => {
    vi.useFakeTimers();
    try {
      const parent = new AbortController();
      const t = timedSignal(parent.signal, 60_000);
      parent.abort(new Error('cancelled'));
      expect(t.signal.aborted).toBe(true);
      expect(t.timedOut()).toBe(false);
      t.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is already aborted if the parent is', () => {
    const parent = new AbortController();
    parent.abort();
    const t = timedSignal(parent.signal, 1000);
    expect(t.signal.aborted).toBe(true);
    t.dispose();
  });

  it('a sleep ends early when the signal fires, and says it did', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const done = sleepUnlessAborted(10_000, controller.signal);
      controller.abort();
      await expect(done).resolves.toBe(false);
      const full = sleepUnlessAborted(500);
      vi.advanceTimersByTime(500);
      await expect(full).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('backoffDelayMs', () => {
  const options = { baseMs: 200, maxDelayMs: 2000 };

  it('grows exponentially and is capped', () => {
    const high = () => 1; // the longest jitter allows
    expect(backoffDelayMs(0, options, high)).toBe(200);
    expect(backoffDelayMs(1, options, high)).toBe(400);
    expect(backoffDelayMs(2, options, high)).toBe(800);
    expect(backoffDelayMs(10, options, high)).toBe(2000);
    expect(backoffDelayMs(50, options, high)).toBe(2000);
  });

  it('jitters between half the planned wait and all of it', () => {
    expect(backoffDelayMs(2, options, () => 0)).toBe(400);
    expect(backoffDelayMs(2, options, () => 1)).toBe(800);
    const middle = backoffDelayMs(2, options, () => 0.5);
    expect(middle).toBeGreaterThan(400);
    expect(middle).toBeLessThan(800);
  });
});

describe('RetryBudget', () => {
  it('runs out of retries when nothing is succeeding to earn them', () => {
    const budget = new RetryBudget({ ratio: 0.2, initial: 3, max: 10 });
    expect([budget.tryAcquire(), budget.tryAcquire(), budget.tryAcquire()]).toEqual([true, true, true]);
    expect(budget.tryAcquire()).toBe(false);
  });

  it('earns retries back in proportion to requests, up to a ceiling', () => {
    const budget = new RetryBudget({ ratio: 0.5, initial: 0, max: 2 });
    expect(budget.tryAcquire()).toBe(false);
    budget.recordRequest();
    budget.recordRequest();
    expect(budget.tryAcquire()).toBe(true);
    for (let i = 0; i < 100; i += 1) budget.recordRequest();
    expect(budget.available).toBe(2);
  });
});

describe('CircuitBreaker', () => {
  const make = (c = clock(), extra: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {}) => {
    const transitions: Array<[CircuitState, CircuitState]> = [];
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      recoveryTimeoutMs: 10_000,
      now: c.now,
      onStateChange: (from, to) => transitions.push([from, to]),
      ...extra,
    });
    return { breaker, c, transitions };
  };
  const fail = (b: CircuitBreaker) => {
    const d = b.tryAcquire();
    if (!d.allowed) throw new Error('expected a permit');
    d.permit.failure();
  };
  const succeed = (b: CircuitBreaker) => {
    const d = b.tryAcquire();
    if (!d.allowed) throw new Error('expected a permit');
    d.permit.success();
  };

  it('stays closed while failures are not consecutive', () => {
    const { breaker } = make();
    fail(breaker);
    fail(breaker);
    succeed(breaker);
    fail(breaker);
    fail(breaker);
    expect(breaker.state).toBe('closed');
  });

  it('opens at the failure threshold and refuses calls without letting them through', () => {
    const { breaker, c, transitions } = make();
    fail(breaker);
    fail(breaker);
    fail(breaker);
    expect(breaker.state).toBe('open');
    expect(transitions).toEqual([['closed', 'open']]);
    c.advance(4000);
    const refused = breaker.tryAcquire();
    expect(refused).toEqual({ allowed: false, retryAfterMs: 6000 });
  });

  it('lets one probe through after the recovery timeout, and only one', () => {
    const { breaker, c } = make();
    for (let i = 0; i < 3; i += 1) fail(breaker);
    c.advance(10_000);
    expect(breaker.state).toBe('half_open');
    const first = breaker.tryAcquire();
    expect(first.allowed && first.permit.probe).toBe(true);
    // A second call while the probe is out is refused.
    expect(breaker.tryAcquire().allowed).toBe(false);
  });

  it('a successful probe closes the circuit and resets the count', () => {
    const { breaker, c, transitions } = make();
    for (let i = 0; i < 3; i += 1) fail(breaker);
    c.advance(10_000);
    succeed(breaker);
    expect(breaker.state).toBe('closed');
    expect(breaker.consecutiveFailures).toBe(0);
    expect(transitions).toEqual([
      ['closed', 'open'],
      ['open', 'half_open'],
      ['half_open', 'closed'],
    ]);
    // And it takes the full threshold again to reopen.
    fail(breaker);
    fail(breaker);
    expect(breaker.state).toBe('closed');
  });

  it('a failed probe keeps it open for another full timeout', () => {
    const { breaker, c } = make();
    for (let i = 0; i < 3; i += 1) fail(breaker);
    c.advance(10_000);
    fail(breaker); // the probe
    expect(breaker.state).toBe('open');
    c.advance(9_999);
    expect(breaker.tryAcquire().allowed).toBe(false);
    c.advance(1);
    expect(breaker.state).toBe('half_open');
  });

  it('a call that says nothing about health frees a probe slot without deciding anything', () => {
    const { breaker, c } = make();
    for (let i = 0; i < 3; i += 1) fail(breaker);
    c.advance(10_000);
    const probe = breaker.tryAcquire();
    if (!probe.allowed) throw new Error('expected a permit');
    probe.permit.ignore();
    expect(breaker.state).toBe('half_open');
    expect(breaker.tryAcquire().allowed).toBe(true);
  });

  it('a permit settles once: reporting twice changes nothing', () => {
    const { breaker } = make();
    const d = breaker.tryAcquire();
    if (!d.allowed) throw new Error('expected a permit');
    d.permit.failure();
    d.permit.failure();
    d.permit.failure();
    expect(breaker.consecutiveFailures).toBe(1);
  });

  it('can be opened at once for a provider that says when to come back', () => {
    const { breaker, c } = make();
    breaker.trip(2_000);
    expect(breaker.state).toBe('open');
    c.advance(1_999);
    expect(breaker.tryAcquire().allowed).toBe(false);
    c.advance(1);
    expect(breaker.state).toBe('half_open');
  });

  it('allows the configured number of concurrent probes', () => {
    const { breaker, c } = make(clock(), { halfOpenMaxCalls: 2 });
    for (let i = 0; i < 3; i += 1) fail(breaker);
    c.advance(10_000);
    expect(breaker.tryAcquire().allowed).toBe(true);
    expect(breaker.tryAcquire().allowed).toBe(true);
    expect(breaker.tryAcquire().allowed).toBe(false);
  });

  it('keeps one circuit per key', () => {
    const c = clock();
    const registry = new CircuitRegistry(() => new CircuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 1000, now: c.now }));
    const a = registry.get('amadeus:flights');
    const b = registry.get('amadeus:hotels');
    expect(registry.get('amadeus:flights')).toBe(a);
    const d = a.tryAcquire();
    if (!d.allowed) throw new Error('expected a permit');
    d.permit.failure();
    expect(a.state).toBe('open');
    expect(b.state).toBe('closed');
    expect(registry.snapshot()).toEqual([
      { key: 'amadeus:flights', state: 'open', consecutiveFailures: 1 },
      { key: 'amadeus:hotels', state: 'closed', consecutiveFailures: 0 },
    ]);
  });
});

describe('TtlCache and MemoryCache', () => {
  it('returns a value until it expires, and never after', () => {
    const c = clock();
    const cache = new TtlCache<string>({ maxEntries: 10, now: c.now });
    cache.set('k', 'v', 1000);
    expect(cache.get('k')).toBe('v');
    c.advance(999);
    expect(cache.get('k')).toBe('v');
    c.advance(1);
    expect(cache.get('k')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('holds no more than its ceiling, dropping the oldest', () => {
    const c = clock();
    const cache = new TtlCache<number>({ maxEntries: 3, now: c.now });
    for (let i = 0; i < 6; i += 1) cache.set(`k${i}`, i, 10_000);
    expect(cache.size).toBe(3);
    expect(cache.get('k0')).toBeUndefined();
    expect(cache.get('k5')).toBe(5);
  });

  it('prefers to drop what has expired before what is still good', () => {
    const c = clock();
    const cache = new TtlCache<number>({ maxEntries: 2, now: c.now });
    cache.set('short', 1, 10);
    cache.set('long', 2, 10_000);
    c.advance(50);
    cache.set('new', 3, 10_000);
    expect(cache.get('long')).toBe(2);
    expect(cache.get('new')).toBe(3);
  });

  it('does not store what would already have expired', () => {
    const cache = new TtlCache<string>({ maxEntries: 3 });
    cache.set('k', 'v', 0);
    expect(cache.get('k')).toBeUndefined();
  });

  it('the async cache hands back copies, so a caller cannot change what is cached', async () => {
    const cache = new MemoryCache();
    const original = { list: [1, 2, 3] };
    await cache.set('k', original, 1000);
    original.list.push(4);
    const first = (await cache.get('k')) as { list: number[] };
    expect(first.list).toEqual([1, 2, 3]);
    first.list.push(99);
    expect(((await cache.get('k')) as { list: number[] }).list).toEqual([1, 2, 3]);
  });
});

describe('SingleFlight', () => {
  it('runs one call for callers that ask for the same thing at once', async () => {
    const flight = new SingleFlight<number>();
    let calls = 0;
    let release!: (n: number) => void;
    const work = () => {
      calls += 1;
      return new Promise<number>((resolve) => (release = resolve));
    };
    const all = Promise.all([flight.run('k', work), flight.run('k', work), flight.run('k', work)]);
    release(42);
    await expect(all).resolves.toEqual([42, 42, 42]);
    expect(calls).toBe(1);
  });

  it('asks again once the first call is over, including after a failure', async () => {
    const flight = new SingleFlight<number>();
    let calls = 0;
    await expect(flight.run('k', async () => (calls += 1) && Promise.reject(new Error('no')))).rejects.toThrow('no');
    await expect(flight.run('k', async () => (calls += 1))).resolves.toBe(2);
    expect(calls).toBe(2);
  });

  it('keeps different keys apart', async () => {
    const flight = new SingleFlight<string>();
    const [a, b] = await Promise.all([flight.run('a', async () => 'A'), flight.run('b', async () => 'B')]);
    expect([a, b]).toEqual(['A', 'B']);
  });
});
