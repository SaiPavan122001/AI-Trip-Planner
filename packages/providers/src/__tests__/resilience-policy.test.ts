import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCache, fail, isOk, ok, type ProviderProvenance, type ProviderResult } from '@trip/shared';
import { withBudget } from '../call-scope.js';
import { ResponseCache, CachedRoutingProvider, CachedGeocodingProvider } from '../cache.js';
import { FallbackRoutingProvider, firstAnswer } from '../fallback.js';
import type { ProviderCall } from '../guard.js';
import { RequestAbortedError, httpJson, resetRetryBudgets } from '../http.js';
import { ResilientPolicy, type PolicyEvent } from '../policy.js';
import type { RouteResult, RoutingProvider, GeocodingProvider } from '../types.js';
import { hang, json, serve } from './support/fixtures.js';

/**
 * Circuit breaker, layered time budgets, fallback and caching (Phase 5.2, 5.3,
 * 5.7, 5.9), through the policy that every provider call goes through.
 */

const call = (provider = 'amadeus', capability: ProviderCall['capability'] = 'flights'): ProviderCall => ({
  provider,
  providerLabel: provider.toUpperCase(),
  capability,
  operation: 'op',
});

const provenance = (provider: string): ProviderProvenance => ({
  provider,
  providerLabel: provider.toUpperCase(),
  retrievedAt: '2026-01-01T00:00:00.000Z',
  validUntil: null,
  searchId: null,
  attribution: null,
});
const good = <T>(data: T, provider = 'amadeus') => ok(data, provenance(provider));
const broken = (status: Parameters<typeof fail>[0] = 'unavailable', provider = 'amadeus', retryAfter?: number) =>
  fail(status, provider, provider.toUpperCase(), `${provider} said ${status}.`, retryAfter);

/** A clock the test moves by hand, so a circuit's recovery time passes without waiting. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const policyWith = (c = clock(), events: PolicyEvent[] = [], threshold = 3) =>
  new ResilientPolicy({
    deadlineMs: 45_000,
    circuit: { failureThreshold: threshold, recoveryTimeoutMs: 10_000 },
    now: c.now,
    onEvent: (e) => events.push(e),
  });

beforeEach(() => resetRetryBudgets());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('isolation', () => {
  it('returns what a healthy provider returned, untouched', async () => {
    const result = await policyWith().execute(call(), async () => good([1, 2]));
    expect(isOk(result) && result.data).toEqual([1, 2]);
  });

  it('turns a throw into a failure that names the provider and the capability', async () => {
    const result = await policyWith().execute(call(), async () => {
      throw new Error('kaboom with /internal/path and a secret');
    });
    expect(result).toMatchObject({ status: 'unavailable', provider: 'amadeus', capability: 'flights' });
    expect(JSON.stringify(result)).not.toContain('kaboom');
  });

  it('reports a response the adapter choked on as unusable', async () => {
    const result = await policyWith().execute(call(), async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'x')");
    });
    expect(result.status).toBe('invalid_response');
  });
});

describe('the time a call is allowed', () => {
  it('times out a provider that never answers, at its own ceiling, and says how long it waited', async () => {
    vi.useFakeTimers();
    const policy = new ResilientPolicy({ deadlineMs: 5_000, circuit: null });
    const pending = policy.execute(call(), () => new Promise<never>(() => undefined));
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(result).toMatchObject({ status: 'timeout', capability: 'flights' });
    expect((result as { message: string }).message).toContain('5 seconds');
  });

  it('cannot spend more than the step it belongs to has left, and does not blame the provider for it', async () => {
    vi.useFakeTimers();
    const events: PolicyEvent[] = [];
    const policy = new ResilientPolicy({ deadlineMs: 45_000, circuit: { failureThreshold: 1, recoveryTimeoutMs: 10_000 }, onEvent: (e) => events.push(e) });
    // The step has 2 s; the provider would happily take 40.
    const pending = withBudget({ ms: 2_000 }, () => policy.execute(call(), () => new Promise<never>(() => undefined)));
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;
    expect(result.status).toBe('timeout');
    expect((result as { local?: boolean }).local).toBe(true);
    expect((result as { message: string }).message).toMatch(/time this step/);
    // One such failure with a threshold of one: a provider that was really at fault would have opened the circuit.
    expect(policy.circuitStates()[0]?.state).toBe('closed');
  });

  it('a provider that hangs cannot stop the others in the same step from being used', async () => {
    vi.useFakeTimers();
    const policy = policyWith();
    const results = withBudget({ ms: 3_000 }, () =>
      Promise.all([
        policy.execute(call('slow', 'trains'), () => new Promise<never>(() => undefined)),
        policy.execute(call('quick', 'buses'), async () => good(['bus'], 'quick')),
      ]),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    const [slow, quick] = await results;
    expect(slow?.status).toBe('timeout');
    expect(isOk(quick!) && quick.data).toEqual(['bus']);
  });

  it('gives the HTTP requests inside a call the call\'s time, so nothing runs on after it', async () => {
    vi.useFakeTimers();
    const { requests } = serve({ '/slow': hang });
    const policy = new ResilientPolicy({ deadlineMs: 4_000, circuit: null });
    const pending = policy.execute(call(), async () => {
      await httpJson('https://provider.test/slow', { timeoutMs: 60_000, retries: 3 });
      return good([]);
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect((await pending).status).toBe('timeout');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(requests).toHaveLength(1); // aborted and not retried after the deadline
  });

  it('stops a cancelled search, and tells it apart from a provider being slow', async () => {
    const controller = new AbortController();
    const policy = policyWith();
    const pending = withBudget({ ms: 30_000, signal: controller.signal }, () =>
      policy.execute(call(), () => new Promise<never>(() => undefined)),
    );
    controller.abort(new Error('cancelled'));
    const result = await pending;
    expect(result.status).toBe('timeout');
    expect((result as { message: string }).message).toMatch(/stopped/);
    expect((result as { local?: boolean }).local).toBe(true);
  });

  it('stops asking for more requests once a search has used its allowance', async () => {
    serve({ '/x': json({ ok: true }) });
    const policy = policyWith();
    const run = () =>
      policy.execute(call(), async () => {
        await httpJson('https://provider.test/x');
        return good(['ok']);
      });
    const results = await withBudget({ ms: 30_000, maxRequests: 2 }, async () => [await run(), await run(), await run()]);
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok', 'unavailable']);
    expect((results[2] as { message: string }).message).toMatch(/limit/);
    expect((results[2] as { local?: boolean }).local).toBe(true);
  });
});

describe('circuit breaker', () => {
  it('opens after the configured run of failures, then stops calling the provider at all', async () => {
    const c = clock();
    const events: PolicyEvent[] = [];
    const policy = policyWith(c, events);
    let calls = 0;
    const failing = async () => (calls += 1, broken('unavailable'));
    for (let i = 0; i < 3; i += 1) await policy.execute(call(), failing);
    expect(policy.circuitStates()).toEqual([{ key: 'amadeus:flights', state: 'open', consecutiveFailures: 3 }]);
    const skipped = await policy.execute(call(), failing);
    expect(calls).toBe(3); // the fourth request was never made
    expect(skipped.status).toBe('unavailable');
    const message = (skipped as { message: string }).message;
    expect(message).toMatch(/not asked/);
    expect(message).toMatch(/10 seconds/);
    // Keeps the original failure rather than hiding it behind a generic one.
    expect(message).toContain('amadeus said unavailable');
    expect(events).toContainEqual({ type: 'circuit', key: 'amadeus:flights', from: 'closed', to: 'open' });
    expect(events.some((e) => e.type === 'skipped')).toBe(true);
  });

  it('is per provider and capability: hotels failing does not stop flights', async () => {
    const policy = policyWith();
    for (let i = 0; i < 3; i += 1) await policy.execute(call('amadeus', 'hotels'), async () => broken());
    let flightsCalled = false;
    const flights = await policy.execute(call('amadeus', 'flights'), async () => ((flightsCalled = true), good(['f'])));
    expect(flightsCalled).toBe(true);
    expect(flights.status).toBe('ok');
    const other = await policy.execute(call('google-maps', 'hotels'), async () => good(['h'], 'google-maps'));
    expect(other.status).toBe('ok');
  });

  it('lets one probe through after the recovery time; a good answer closes the circuit', async () => {
    const c = clock();
    const policy = policyWith(c);
    for (let i = 0; i < 3; i += 1) await policy.execute(call(), async () => broken());
    c.advance(10_000);
    let probes = 0;
    const probe = await policy.execute(call(), async () => (probes += 1, good(['back'])));
    expect(probe.status).toBe('ok');
    expect(probes).toBe(1);
    expect(policy.circuitStates()[0]?.state).toBe('closed');
    // Fully closed again: ordinary calls flow.
    expect((await policy.execute(call(), async () => good(['again']))).status).toBe('ok');
  });

  it('a failed probe keeps the circuit open for another full recovery time', async () => {
    const c = clock();
    const policy = policyWith(c);
    for (let i = 0; i < 3; i += 1) await policy.execute(call(), async () => broken());
    c.advance(10_000);
    await policy.execute(call(), async () => broken('timeout'));
    expect(policy.circuitStates()[0]?.state).toBe('open');
    c.advance(9_000);
    let called = false;
    await policy.execute(call(), async () => ((called = true), good([])));
    expect(called).toBe(false);
    c.advance(1_000);
    await policy.execute(call(), async () => ((called = true), good([])));
    expect(called).toBe(true);
  });

  it('while a probe is out, other calls are still refused', async () => {
    const c = clock();
    const policy = policyWith(c);
    for (let i = 0; i < 3; i += 1) await policy.execute(call(), async () => broken());
    c.advance(10_000);
    let release!: (r: ProviderResult<string[]>) => void;
    const probe = policy.execute(call(), () => new Promise<ProviderResult<string[]>>((resolve) => (release = resolve)));
    let second = false;
    const refused = await policy.execute(call(), async () => ((second = true), good([])));
    expect(second).toBe(false);
    expect(refused.status).toBe('unavailable');
    release(good(['ok']));
    await probe;
  });

  it('does not count a provider that answered "nothing found" as failing, and that answer resets the count', async () => {
    const policy = policyWith();
    await policy.execute(call(), async () => broken());
    await policy.execute(call(), async () => broken());
    await policy.execute(call(), async () => broken('no_availability'));
    await policy.execute(call(), async () => broken());
    await policy.execute(call(), async () => broken());
    expect(policy.circuitStates()[0]?.state).toBe('closed');
  });

  it('does not count our own bad request, or rejected credentials, as an unhealthy provider', async () => {
    const policy = policyWith();
    for (let i = 0; i < 6; i += 1) await policy.execute(call(), async () => broken('invalid_request'));
    for (let i = 0; i < 6; i += 1) await policy.execute(call(), async () => broken('not_configured'));
    expect(policy.circuitStates()[0]?.state).toBe('closed');
  });

  it('counts unusable responses: a provider that answers nonsense is not healthy', async () => {
    const policy = policyWith();
    for (let i = 0; i < 3; i += 1) await policy.execute(call(), async () => broken('invalid_response'));
    expect(policy.circuitStates()[0]?.state).toBe('open');
  });

  it('a provider that says "slow down" is left alone for as long as it asked, not counted as broken', async () => {
    const c = clock();
    const policy = policyWith(c);
    const limited = await policy.execute(call(), async () => broken('rate_limited', 'amadeus', 20));
    expect(limited.status).toBe('rate_limited');
    expect(policy.circuitStates()[0]?.state).toBe('open');
    c.advance(19_000);
    let called = false;
    await policy.execute(call(), async () => ((called = true), good([])));
    expect(called).toBe(false);
    c.advance(1_000);
    await policy.execute(call(), async () => ((called = true), good([])));
    expect(called).toBe(true);
  });

  it('can be switched off', async () => {
    const policy = new ResilientPolicy({ deadlineMs: 1000, circuit: null });
    let calls = 0;
    for (let i = 0; i < 10; i += 1) await policy.execute(call(), async () => (calls += 1, broken()));
    expect(calls).toBe(10);
  });
});

// ------------------------------------------------------------------ fallback

const route = (km: number): RouteResult => ({ distanceKm: km, durationMinutes: km, geometry: null });

function routing(id: string, answer: () => Promise<ProviderResult<RouteResult>>): RoutingProvider & { asked: number } {
  const p = {
    asked: 0,
    descriptor: { id, label: id.toUpperCase(), kinds: ['routing' as const], requiredEnv: [], coverage: 'global' as const, docsUrl: null, attribution: null },
    isConfigured: () => true,
    health: async () => ok({ ok: true as const, latencyMs: 1 }, provenance(id)),
    route: async () => {
      p.asked += 1;
      return answer();
    },
  };
  return p;
}

const request = { from: { lat: 17.385, lon: 78.4867 }, to: { lat: 12.9716, lon: 77.5946 }, profile: 'driving' as const };

describe('fallback between providers', () => {
  it('uses the preferred provider when it works, and does not touch the other', async () => {
    const google = routing('google', async () => good(route(100), 'google'));
    const osrm = routing('osrm', async () => good(route(90), 'osrm'));
    const res = await new FallbackRoutingProvider([google, osrm], policyWith()).route(request);
    expect(isOk(res) && res.provenance.provider).toBe('google');
    expect(osrm.asked).toBe(0);
    expect(isOk(res) && res.warnings).toEqual([]);
  });

  it.each([
    ['fails', () => Promise.resolve(broken('unavailable', 'google'))],
    ['answers with something unusable', () => Promise.resolve(broken('invalid_response', 'google'))],
    ['throws', () => Promise.reject(new Error('boom'))],
  ])('when the preferred provider %s, the next one answers, and the answer says so', async (_name, primary) => {
    const google = routing('google', primary as () => Promise<ProviderResult<RouteResult>>);
    const osrm = routing('osrm', async () => good(route(90), 'osrm'));
    const res = await new FallbackRoutingProvider([google, osrm], policyWith()).route(request);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    // Which provider supplied the answer can be told from the answer itself.
    expect(res.provenance.provider).toBe('osrm');
    expect(res.data.distanceKm).toBe(90);
    expect(res.warnings.join(' ')).toMatch(/GOOGLE/);
    expect(res.warnings.join(' ')).toMatch(/OSRM answered instead/);
  });

  it('when the preferred provider times out, the next is tried within the time that is left', async () => {
    vi.useFakeTimers();
    const google = routing('google', () => new Promise<never>(() => undefined));
    const osrm = routing('osrm', async () => good(route(90), 'osrm'));
    const policy = new ResilientPolicy({ deadlineMs: 5_000, circuit: null });
    const pending = new FallbackRoutingProvider([google, osrm], policy).route(request);
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await pending;
    expect(isOk(res) && res.provenance.provider).toBe('osrm');
    expect(isOk(res) && res.warnings.join(' ')).toMatch(/did not answer within 5 seconds/);
  });

  it('when every provider fails, the failure lists them all and no data is invented', async () => {
    const google = routing('google', async () => broken('unavailable', 'google'));
    const osrm = routing('osrm', async () => broken('timeout', 'osrm'));
    const res = await new FallbackRoutingProvider([google, osrm], policyWith()).route(request);
    expect(isOk(res)).toBe(false);
    if (isOk(res)) return;
    expect(res.status).toBe('unavailable'); // the preferred provider's status
    expect(res.message).toMatch(/google said unavailable/);
    expect(res.message).toMatch(/OSRM was then tried and also failed: osrm said timeout/);
    expect(res.capability).toBe('routing');
  });

  it('skips a provider whose circuit is open without calling it, and still answers from the next', async () => {
    const policy = policyWith();
    const google = routing('google', async () => broken('unavailable', 'google'));
    const osrm = routing('osrm', async () => good(route(90), 'osrm'));
    const chain = new FallbackRoutingProvider([google, osrm], policy);
    for (let i = 0; i < 3; i += 1) await chain.route(request);
    expect(google.asked).toBe(3);
    const res = await chain.route(request);
    expect(google.asked).toBe(3);
    expect(isOk(res) && res.provenance.provider).toBe('osrm');
    expect(isOk(res) && res.warnings.join(' ')).toMatch(/not asked/);
  });

  it('does not go on to another provider when the search itself was cancelled', async () => {
    const controller = new AbortController();
    const google = routing('google', () => new Promise<never>(() => undefined));
    const osrm = routing('osrm', async () => good(route(90), 'osrm'));
    const chain = new FallbackRoutingProvider([google, osrm], policyWith());
    const pending = withBudget({ ms: 30_000, signal: controller.signal }, () => chain.route(request));
    controller.abort(new Error('cancelled'));
    const res = await pending;
    expect(isOk(res)).toBe(false);
    expect(osrm.asked).toBe(0);
  });

  it('with nothing to ask, says so instead of returning something', async () => {
    const res = await firstAnswer(policyWith(), []);
    expect(res.status).toBe('unavailable');
  });
});

// --------------------------------------------------------------------- cache

function cacheWith(c = clock(), events: string[] = [], store = new MemoryCache({ now: c.now })) {
  return { cache: new ResponseCache({ store, ttls: { geocodingMs: 60_000, routingMs: 60_000, activitiesMs: 60_000 }, onEvent: (e) => events.push(e.type) }), c, store, events };
}

describe('caching', () => {
  it('answers the second identical request from the cache, with the original provenance', async () => {
    const { cache, events } = cacheWith();
    const inner = routing('osrm', async () => good(route(90), 'osrm'));
    const cached = new CachedRoutingProvider(inner, cache);
    const first = await cached.route(request);
    const second = await cached.route(request);
    expect(inner.asked).toBe(1);
    expect(isOk(second) && second.data).toEqual(route(90));
    if (!isOk(first) || !isOk(second)) throw new Error('both should have succeeded');
    expect(second.provenance).toEqual(first.provenance);
    expect(events).toEqual(['miss', 'store', 'hit']);
  });

  it('expires: after the time to live the provider is asked again', async () => {
    const { cache, c } = cacheWith();
    const inner = routing('osrm', async () => good(route(90), 'osrm'));
    const cached = new CachedRoutingProvider(inner, cache);
    await cached.route(request);
    c.advance(59_000);
    await cached.route(request);
    expect(inner.asked).toBe(1);
    c.advance(2_000);
    await cached.route(request);
    expect(inner.asked).toBe(2);
  });

  it('keys on every parameter the answer depends on', async () => {
    const { cache } = cacheWith();
    const inner = routing('osrm', async () => good(route(90), 'osrm'));
    const cached = new CachedRoutingProvider(inner, cache);
    await cached.route(request);
    await cached.route({ ...request, profile: 'walking' });
    await cached.route({ ...request, to: { lat: 13.5, lon: 77.5946 } });
    await cached.route({ ...request, departAt: '2030-01-01T04:00:00.000Z' });
    await cached.route({ ...request, departAt: '2030-01-01T06:00:00.000Z' });
    expect(inner.asked).toBe(5);
    // The same thing again, and a departure in the same half hour, are hits.
    await cached.route(request);
    await cached.route({ ...request, departAt: '2030-01-01T06:10:00.000Z' });
    expect(inner.asked).toBe(5);
  });

  it('never mixes providers: the same question to two providers is two entries', async () => {
    const { cache } = cacheWith();
    const a = routing('google', async () => good(route(100), 'google'));
    const b = routing('osrm', async () => good(route(90), 'osrm'));
    const ra = await new CachedRoutingProvider(a, cache).route(request);
    const rb = await new CachedRoutingProvider(b, cache).route(request);
    expect(isOk(ra) && ra.data.distanceKm).toBe(100);
    expect(isOk(rb) && rb.data.distanceKm).toBe(90);
  });

  it('does not keep failures or "nothing found", so a recovering provider is asked again', async () => {
    const { cache } = cacheWith();
    let answers: ProviderResult<RouteResult>[] = [broken('unavailable', 'osrm'), broken('no_availability', 'osrm'), good(route(90), 'osrm')];
    const inner = routing('osrm', async () => answers.shift()!);
    const cached = new CachedRoutingProvider(inner, cache);
    expect((await cached.route(request)).status).toBe('unavailable');
    expect((await cached.route(request)).status).toBe('no_availability');
    expect((await cached.route(request)).status).toBe('ok');
    expect((await cached.route(request)).status).toBe('ok');
    expect(inner.asked).toBe(3);
    answers = [];
  });

  it('treats an entry that does not look like what a fresh answer would look like as a miss', async () => {
    const { cache, store, events } = cacheWith();
    const inner = routing('osrm', async () => good(route(90), 'osrm'));
    const cached = new CachedRoutingProvider(inner, cache);
    await cached.route(request);
    const key = ResponseCache.keyFor('osrm', 'route', { from: { lat: 17.385, lon: 78.4867 }, to: { lat: 12.9716, lon: 77.5946 }, profile: 'driving', departBucket: null });
    await store.set(key, { data: { distanceKm: 'far', durationMinutes: -1 }, provenance: { provider: 'osrm', providerLabel: 'OSRM', retrievedAt: 'x' }, warnings: [] }, 60_000);
    const res = await cached.route(request);
    expect(isOk(res) && res.data).toEqual(route(90));
    expect(inner.asked).toBe(2);
    expect(events).toContain('invalid');
  });

  it('carries on when the store is unavailable: a cache is a speed-up, never a dependency', async () => {
    const down = { get: async () => Promise.reject(new Error('redis down')), set: async () => Promise.reject(new Error('redis down')) };
    const { cache } = cacheWith(clock(), [], down as never);
    const inner = routing('osrm', async () => good(route(90), 'osrm'));
    const res = await new CachedRoutingProvider(inner, cache).route(request);
    expect(isOk(res) && res.data).toEqual(route(90));
  });

  it('asks once when many identical requests arrive together', async () => {
    const { cache } = cacheWith();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inner = routing('osrm', async () => (await gate, good(route(90), 'osrm')));
    const cached = new CachedRoutingProvider(inner, cache);
    const all = Promise.all([cached.route(request), cached.route(request), cached.route(request)]);
    await new Promise((r) => setTimeout(r, 10));
    release();
    const results = await all;
    expect(results.every(isOk)).toBe(true);
    expect(inner.asked).toBe(1);
  });

  it('a caller whose own search was cancelled does not hand its cancellation to the others', async () => {
    const { cache } = cacheWith();
    const first = new AbortController();
    let n = 0;
    const inner = routing('osrm', async () => {
      n += 1;
      if (n === 1) {
        await new Promise((r) => setTimeout(r, 20));
        return { ...fail('timeout', 'osrm', 'OSRM', 'The search was stopped before OSRM answered.'), local: true } as ProviderResult<RouteResult>;
      }
      return good(route(90), 'osrm');
    });
    const cached = new CachedRoutingProvider(inner, cache);
    const leader = cached.route(request);
    const follower = cached.route(request);
    first.abort();
    expect((await leader).status).toBe('timeout');
    const res = await follower;
    expect(isOk(res) && res.data).toEqual(route(90)); // asked for itself
  });

  it('caches places by what was typed, ignoring case and spacing, and by nothing about who typed it', async () => {
    const { cache } = cacheWith();
    let asked = 0;
    const place = { id: 'p', name: 'Goa', displayName: 'Goa, India', coordinates: { lat: 15.3, lon: 74 }, countryCode: 'IN', countryName: 'India', timezone: 'Asia/Kolkata', airports: [], source: 'nominatim', resolvedAt: '2026-01-01T00:00:00.000Z' };
    const inner: GeocodingProvider = {
      descriptor: { id: 'nominatim', label: 'Nominatim', kinds: ['geocoding'], requiredEnv: [], coverage: 'global', docsUrl: null, attribution: null },
      isConfigured: () => true,
      health: async () => ok({ ok: true as const, latencyMs: 1 }, provenance('nominatim')),
      resolvePlace: async () => (asked += 1, ok([place], provenance('nominatim'))),
      reverse: async () => ok(place, provenance('nominatim')),
    };
    const geo = new CachedGeocodingProvider(inner, cache);
    await geo.resolvePlace('Goa', { limit: 5 });
    await geo.resolvePlace('  goa ', { limit: 5 });
    await geo.resolvePlace('GOA', { limit: 5 });
    expect(asked).toBe(1);
    await geo.resolvePlace('Goa', { limit: 6 });
    await geo.resolvePlace('Goa, India', { limit: 5 });
    expect(asked).toBe(3);
  });

  it('holds no more than its ceiling', async () => {
    const c = clock();
    const store = new MemoryCache({ maxEntries: 3, now: c.now });
    const { cache } = cacheWith(c, [], store);
    const inner = routing('osrm', async () => good(route(90), 'osrm'));
    const cached = new CachedRoutingProvider(inner, cache);
    for (let i = 0; i < 10; i += 1) await cached.route({ ...request, to: { lat: 10 + i, lon: 70 } });
    // The first ones were pushed out: asking again goes to the provider.
    const before = inner.asked;
    await cached.route({ ...request, to: { lat: 10, lon: 70 } });
    expect(inner.asked).toBe(before + 1);
  });
});

describe('a cancelled request is reported as cancelled', () => {
  it('through the HTTP client, into a failure that is local', async () => {
    const c = new AbortController();
    c.abort();
    const err = await httpJson('https://provider.test/x', { signal: c.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestAbortedError);
  });
});
