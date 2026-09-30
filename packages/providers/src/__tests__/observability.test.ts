import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCache, fail, ok, type ProviderProvenance, type ProviderResult } from '@trip/shared';
import { memorySpanExporter, registry, resetMetrics, resetTracing, setupTracing, withCorrelation, withSpan } from '@trip/telemetry';
import { CachedRoutingProvider, ResponseCache } from '../cache.js';
import { FallbackRoutingProvider } from '../fallback.js';
import type { ProviderCall } from '../guard.js';
import { httpJson, resetRetryBudgets } from '../http.js';
import { ResilientPolicy } from '../policy.js';
import type { RouteResult, RoutingProvider } from '../types.js';
import { json, serve } from './support/fixtures.js';

/**
 * What the provider layer reports about itself (Phase 7): a span and metrics for
 * every call, retry, fallback, circuit change and cache lookup, using only the
 * provider, the capability and the outcome, and nothing that was asked or answered.
 */

const call = (provider = 'amadeus', capability: ProviderCall['capability'] = 'flights'): ProviderCall => ({
  provider,
  providerLabel: provider.toUpperCase(),
  capability,
  operation: 'searchFlights',
});
const provenance = (provider: string): ProviderProvenance => ({ provider, providerLabel: provider, retrievedAt: '2026-01-01T00:00:00.000Z', validUntil: null, searchId: null, attribution: null });
const good = <T>(data: T, provider = 'amadeus') => ok(data, provenance(provider));
const broken = (status: Parameters<typeof fail>[0], provider = 'amadeus') => fail(status, provider, provider, `${provider} said ${status}`);

let exporter: ReturnType<typeof memorySpanExporter>;
const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};
const policyWith = (c = clock(), threshold = 3) => new ResilientPolicy({ deadlineMs: 45_000, circuit: { failureThreshold: threshold, recoveryTimeoutMs: 10_000 }, now: c.now });
const spans = (name: string) => exporter.getFinishedSpans().filter((s) => s.name === name);

beforeEach(async () => {
  resetMetrics();
  resetRetryBudgets();
  exporter = memorySpanExporter();
  await setupTracing({ serviceName: 'test', environment: 'test', exporter });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await resetTracing();
});

describe('a provider call', () => {
  it('is one span with the provider, capability, operation and outcome', async () => {
    await policyWith().execute(call(), async () => good([1]));
    const [span] = spans('provider.call');
    expect(span!.attributes).toMatchObject({
      'provider.id': 'amadeus',
      'provider.capability': 'flights',
      'provider.operation': 'searchFlights',
      'provider.status': 'ok',
      'provider.outcome': 'ok',
    });
    expect(span!.status.code).not.toBe(2); // not an error
  });

  it('counts the call and observes its latency, by provider and capability', async () => {
    await policyWith().execute(call(), async () => good([1]));
    expect(registry.value('provider_calls_total', { provider: 'amadeus', capability: 'flights', outcome: 'ok' })).toBe(1);
    expect(registry.value('provider_call_duration_seconds', { provider: 'amadeus', capability: 'flights' })).toBe(1);
  });

  it.each([
    ['unavailable', 'failed', 'provider_unavailable'],
    ['timeout', 'timed_out', 'provider_timeout'],
    ['rate_limited', 'rate_limited', 'rate_limited'],
    ['invalid_response', 'unusable', 'provider_invalid_response'],
    ['not_configured', 'not_available', 'provider_rejected'],
  ] as const)('classifies a %s answer as outcome "%s" and error category "%s", on the span and in the metrics', async (status, outcome, category) => {
    await policyWith(clock(), 100).execute(call(), async () => broken(status));
    expect(registry.value('provider_calls_total', { outcome })).toBe(1);
    expect(registry.value('provider_errors_total', { category })).toBe(1);
    const [span] = spans('provider.call');
    expect(span!.attributes['provider.outcome']).toBe(outcome);
    expect(span!.attributes['error.category']).toBe(category);
    expect(span!.status.code).toBe(2);
  });

  it('does not count "nothing found" as an error: it is an answer', async () => {
    await policyWith().execute(call(), async () => broken('no_availability'));
    expect(registry.value('provider_calls_total', { outcome: 'empty' })).toBe(1);
    expect(registry.value('provider_errors_total')).toBe(0);
    expect(spans('provider.call')[0]!.status.code).not.toBe(2);
  });

  it('turns a throw into a failed span and an "unavailable" outcome without recording the error text', async () => {
    const secret = 'ECONNRESET talking to https://user:hunter2@internal.example with key sk-abcdef';
    await policyWith().execute(call(), async () => {
      throw new Error(secret);
    });
    expect(registry.value('provider_calls_total', { outcome: 'failed' })).toBe(1);
    const recorded = JSON.stringify(spans('provider.call').map((s) => ({ a: s.attributes, e: s.events, st: s.status })));
    expect(recorded).not.toMatch(/hunter2|sk-abcdef|internal\.example/);
    expect(JSON.stringify(registry.snapshot())).not.toMatch(/hunter2|sk-abcdef|internal\.example/);
  });

  it('marks a call cut off by its stage as local, and not as the provider\'s fault', async () => {
    vi.useFakeTimers();
    const policy = policyWith();
    const { withBudget } = await import('../call-scope.js');
    const pending = withBudget({ ms: 1_000 }, () => policy.execute(call(), () => new Promise<never>(() => undefined)));
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    const [span] = spans('provider.call');
    expect(span!.attributes['provider.local']).toBe(true);
    expect(span!.status.code).not.toBe(2);
    expect(registry.value('provider_calls_total', { outcome: 'timed_out' })).toBe(1);
  });

  it('nests under whatever span is active, and carries the run and request identifiers', async () => {
    await withCorrelation({ requestId: 'req-1', runId: 'run-1', tripId: 'trip-1' }, () =>
      withSpan('planning.run', {}, () => policyWith().execute(call(), async () => good([1]))),
    );
    const [child] = spans('provider.call');
    const [parent] = spans('planning.run');
    expect(child!.parentSpanContext?.spanId).toBe(parent!.spanContext().spanId);
    expect(child!.attributes).toMatchObject({ 'trip.request_id': 'req-1', 'trip.run_id': 'run-1', 'trip.trip_id': 'trip-1' });
  });

  it('records a provider with an odd id as "invalid" rather than letting it become a label', async () => {
    await policyWith().execute({ ...call(), provider: 'Some Provider With Spaces & Text' }, async () => good([1]));
    expect(registry.value('provider_calls_total', { provider: 'invalid' })).toBe(1);
  });
});

describe('the circuit breaker', () => {
  it('reports each state change, and each call it saved', async () => {
    const c = clock();
    const policy = policyWith(c, 3);
    for (let i = 0; i < 3; i += 1) await policy.execute(call(), async () => broken('unavailable'));
    expect(registry.value('provider_circuit_transitions_total', { provider: 'amadeus', capability: 'flights', to: 'open' })).toBe(1);
    await policy.execute(call(), async () => good([1])); // skipped
    await policy.execute(call(), async () => good([1])); // skipped
    expect(registry.value('provider_circuit_skips_total', { provider: 'amadeus', capability: 'flights' })).toBe(2);
    expect(registry.value('provider_calls_total', { outcome: 'skipped_circuit_open' })).toBe(2);
    const skipped = spans('provider.call').filter((s) => s.attributes['provider.circuit_skipped'] === true);
    expect(skipped).toHaveLength(2);

    c.advance(10_000);
    await policy.execute(call(), async () => good([1])); // the probe
    expect(registry.value('provider_circuit_transitions_total', { to: 'half_open' })).toBe(1);
    expect(registry.value('provider_circuit_transitions_total', { to: 'closed' })).toBe(1);
  });

  it('counts an opening per provider and capability, so a repeating one stands out', async () => {
    const policy = policyWith(clock(), 1);
    await policy.execute(call('amadeus', 'hotels'), async () => broken('unavailable'));
    await policy.execute(call('google', 'routing'), async () => broken('unavailable', 'google'));
    expect(registry.value('provider_circuit_transitions_total', { provider: 'amadeus', capability: 'hotels', to: 'open' })).toBe(1);
    expect(registry.value('provider_circuit_transitions_total', { provider: 'google', capability: 'routing', to: 'open' })).toBe(1);
  });
});

describe('retries', () => {
  it('counts a retried request against the provider and capability that caused it, and marks the span', async () => {
    vi.useFakeTimers();
    let n = 0;
    serve({ '/api': () => (n++ === 0 ? json({}, 503) : json({ ok: true })) });
    const policy = policyWith();
    const pending = policy.execute(call(), async () => {
      await httpJson('https://provider.test/api', { random: () => 0 });
      return good([1]);
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(registry.value('provider_retries_total', { provider: 'amadeus', capability: 'flights', reason: 'server_error' })).toBe(1);
    const [span] = spans('provider.call');
    expect(span!.events.map((e) => e.name)).toEqual(['retry']);
    expect(span!.events[0]!.attributes).toMatchObject({ attempt: 1, reason: 'server_error' });
  });

  it('tells a timeout retry and a network retry apart', async () => {
    vi.useFakeTimers();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (n++ === 0) throw new TypeError('fetch failed');
      return new Response('{}', { status: 200 });
    }));
    const pending = policyWith().execute(call(), async () => {
      await httpJson('https://provider.test/api', { random: () => 0 });
      return good([1]);
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(registry.value('provider_retries_total', { reason: 'network' })).toBe(1);
  });

  it('records no retry when there was none, and none for a 429 (which is never retried)', async () => {
    serve({ '/api': json({}, 429, { 'retry-after': '5' }) });
    await policyWith().execute(call(), async () => {
      await httpJson('https://provider.test/api').catch(() => undefined);
      return broken('rate_limited');
    });
    expect(registry.value('provider_retries_total')).toBe(0);
  });

  it('reports a retry budget that ran out', async () => {
    vi.useFakeTimers();
    serve({ '/api': json({}, 503) });
    // Exhaust the host's retry budget with many failing calls.
    for (let i = 0; i < 30; i += 1) {
      const p = policyWith(clock(), 1000).execute(call(), async () => {
        await httpJson('https://provider.test/api', { random: () => 0 }).catch(() => undefined);
        return broken('unavailable');
      });
      await vi.advanceTimersByTimeAsync(20_000);
      await p;
    }
    const events = spans('provider.call').flatMap((s) => s.events.map((e) => e.name));
    expect(events).toContain('retry_budget_exhausted');
  });
});

describe('fallback', () => {
  const routing = (id: string, answer: () => Promise<ProviderResult<RouteResult>>): RoutingProvider => ({
    descriptor: { id, label: id, kinds: ['routing'], requiredEnv: [], coverage: 'global', docsUrl: null, attribution: null },
    isConfigured: () => true,
    health: async () => ok({ ok: true as const, latencyMs: 1 }, provenance(id)),
    route: answer,
  });
  const route = { distanceKm: 1, durationMinutes: 1, geometry: null };
  const request = { from: { lat: 1, lon: 1 }, to: { lat: 2, lon: 2 }, profile: 'driving' as const };

  it('counts a fallback by which provider took over from which, and puts the event on the span', async () => {
    const chain = new FallbackRoutingProvider(
      [routing('google', async () => broken('unavailable', 'google')), routing('osrm', async () => good(route, 'osrm'))],
      policyWith(),
    );
    await withSpan('planning.run', {}, () => chain.route(request));
    expect(registry.value('provider_fallbacks_total', { capability: 'routing', from: 'google', to: 'osrm' })).toBe(1);
    expect(spans('planning.run')[0]!.events.map((e) => e.name)).toContain('fallback');
    // Both providers were called, each as its own span.
    expect(spans('provider.call').map((s) => s.attributes['provider.id']).sort()).toEqual(['google', 'osrm']);
  });

  it('counts nothing when the preferred provider answers', async () => {
    const chain = new FallbackRoutingProvider([routing('google', async () => good(route, 'google')), routing('osrm', async () => good(route, 'osrm'))], policyWith());
    await chain.route(request);
    expect(registry.value('provider_fallbacks_total')).toBe(0);
  });
});

describe('the cache', () => {
  const routing = (): RoutingProvider => ({
    descriptor: { id: 'osrm', label: 'osrm', kinds: ['routing'], requiredEnv: [], coverage: 'global', docsUrl: null, attribution: null },
    isConfigured: () => true,
    health: async () => ok({ ok: true as const, latencyMs: 1 }, provenance('osrm')),
    route: async () => good({ distanceKm: 1, durationMinutes: 1, geometry: null }, 'osrm'),
  });
  const request = { from: { lat: 1, lon: 1 }, to: { lat: 2, lon: 2 }, profile: 'driving' as const };

  it('counts a miss then a store, then a hit, by operation', async () => {
    const cache = new ResponseCache({ store: new MemoryCache() });
    const cached = new CachedRoutingProvider(routing(), cache);
    await cached.route(request);
    await cached.route(request);
    expect(registry.value('cache_events_total', { operation: 'route', event: 'miss' })).toBe(1);
    expect(registry.value('cache_events_total', { operation: 'route', event: 'store' })).toBe(1);
    expect(registry.value('cache_events_total', { operation: 'route', event: 'hit' })).toBe(1);
  });

  it('counts a store that fails as an error, and an entry that does not validate as invalid', async () => {
    const down = { get: async () => Promise.reject(new Error('redis down')), set: async () => Promise.reject(new Error('redis down')) };
    await new CachedRoutingProvider(routing(), new ResponseCache({ store: down as never })).route(request);
    expect(registry.value('cache_events_total', { event: 'error' })).toBeGreaterThanOrEqual(1);

    resetMetrics();
    const store = new MemoryCache();
    const cache = new ResponseCache({ store });
    const key = ResponseCache.keyFor('osrm', 'route', { from: { lat: 1, lon: 1 }, to: { lat: 2, lon: 2 }, profile: 'driving', departBucket: null });
    await store.set(key, { data: { nonsense: true }, provenance: { provider: 'osrm', providerLabel: 'o', retrievedAt: 'x' }, warnings: [] }, 60_000);
    await new CachedRoutingProvider(routing(), cache).route(request);
    expect(registry.value('cache_events_total', { operation: 'route', event: 'invalid' })).toBe(1);
  });
});
