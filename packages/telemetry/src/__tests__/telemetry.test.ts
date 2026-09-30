import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  MetricsRegistry,
  activeTraceIds,
  activeTraceparent,
  addSpanEvent,
  categoryOfError,
  categoryOfHttp,
  categoryOfProviderStatus,
  correlationFields,
  currentCorrelation,
  memorySpanExporter,
  registry,
  resetMetrics,
  resetTracing,
  safeAttributes,
  safeId,
  setupTracing,
  validTraceparent,
  withCorrelation,
  withSpan,
  metrics,
  ERROR_CATEGORIES,
  configureErrorDetail,
  describeError,
} from '../index.js';

/**
 * The telemetry primitives (Phase 7): what may be a metric label, what may be
 * on a span, how correlation travels, and how failures are classified. Every
 * clock and exporter is in memory, so nothing here waits or touches a network.
 */

afterEach(async () => {
  await resetTracing();
  resetMetrics();
});

describe('the metrics registry', () => {
  it('renders the Prometheus text format, sorted, with HELP and TYPE lines', async () => {
    const r = new MetricsRegistry();
    const c = r.counter('things_total', 'Things.', [{ name: 'kind', allowed: ['a', 'b'] }]);
    c.inc({ kind: 'b' });
    c.inc({ kind: 'a' }, 2);
    c.inc({ kind: 'a' });
    const text = await r.render();
    expect(text).toContain('# HELP things_total Things.');
    expect(text).toContain('# TYPE things_total counter');
    expect(text.indexOf('kind="a"')).toBeLessThan(text.indexOf('kind="b"'));
    expect(text).toContain('things_total{kind="a"} 3');
    expect(text).toContain('things_total{kind="b"} 1');
  });

  it('renders a histogram with cumulative buckets, a sum and a count', async () => {
    const r = new MetricsRegistry();
    const h = r.histogram('wait_seconds', 'Wait.', [], [0.1, 1]);
    h.observe({}, 0.05);
    h.observe({}, 0.5);
    h.observe({}, 5);
    const text = await r.render();
    expect(text).toContain('wait_seconds_bucket{le="0.1"} 1');
    expect(text).toContain('wait_seconds_bucket{le="1"} 2');
    expect(text).toContain('wait_seconds_bucket{le="+Inf"} 3');
    expect(text).toContain('wait_seconds_sum 5.55');
    expect(text).toContain('wait_seconds_count 3');
  });

  it('reads a gauge at scrape time, and drops it from the scrape if it cannot be read', async () => {
    const r = new MetricsRegistry();
    const g = r.gauge('depth', 'Depth.');
    let depth = 3;
    g.collectWith(async () => [{ value: depth }]);
    expect(await r.render()).toContain('depth 3');
    depth = 7;
    expect(await r.render()).toContain('depth 7');
    g.collectWith(async () => {
      throw new Error('database is down');
    });
    const text = await r.render();
    expect(text).not.toContain('depth ');
    expect(text).not.toContain('database');
  });

  it('turns anything but a closed-list value into "other", so a label can never grow without bound', () => {
    const r = new MetricsRegistry();
    const c = r.counter('x_total', 'x', [{ name: 'method', allowed: ['GET', 'POST'] }]);
    c.inc({ method: 'GET' });
    c.inc({ method: 'TRACE' });
    c.inc({ method: "'; DROP TABLE" });
    expect(r.value('x_total', { method: 'GET' })).toBe(1);
    expect(r.value('x_total', { method: 'other' })).toBe(2);
  });

  it('refuses free text as a label value: spaces, addresses, long strings and markup become "invalid"', () => {
    const r = new MetricsRegistry();
    const c = r.counter('y_total', 'y', [{ name: 'route', maxValues: 100 }]);
    for (const text of ['I want to go to Goa in December', 'sam@example.com', '<script>alert(1)</script>', 'x'.repeat(200), 'a\nb', '']) c.inc({ route: text });
    c.inc({ route: '/v1/trips/:id/plan' });
    expect(r.value('y_total', { route: 'invalid' })).toBe(6);
    expect(r.value('y_total', { route: '/v1/trips/:id/plan' })).toBe(1);
  });

  it('caps how many distinct values an open label may take, and how many series a metric may hold', () => {
    const r = new MetricsRegistry();
    const c = r.counter('z_total', 'z', [{ name: 'provider', maxValues: 3 }]);
    for (let i = 0; i < 10; i += 1) c.inc({ provider: `p${i}` });
    expect(c.snapshot().map((s) => s.labels['provider']).sort()).toEqual(['other', 'p0', 'p1', 'p2']);

    const wide = r.counter('w_total', 'w', [{ name: 'a', maxValues: 5000 }, { name: 'b', maxValues: 5000 }]);
    for (let i = 0; i < 1200; i += 1) wide.inc({ a: `a${i}`, b: 'x' });
    expect(wide.snapshot().length).toBeLessThanOrEqual(1000);
    expect(r.value('telemetry_series_dropped_total', { metric: 'w_total' })).toBeGreaterThan(0);
  });

  it('escapes label values in the exposition', async () => {
    const r = new MetricsRegistry();
    const c = r.counter('e_total', 'e', [{ name: 'k', allowed: ['a"b'] }]);
    c.inc({ k: 'a"b' });
    expect(await r.render()).toContain('k="a\\"b"');
  });

  it('ignores negative and non-finite increments and observations', () => {
    const r = new MetricsRegistry();
    const c = r.counter('n_total', 'n');
    c.inc({}, -1);
    c.inc({}, Number.NaN);
    const h = r.histogram('n_seconds', 'n');
    h.observe({}, -1);
    h.observe({}, Number.POSITIVE_INFINITY);
    expect(r.value('n_total')).toBe(0);
    expect(r.value('n_seconds')).toBe(0);
  });

  it('defines the system\'s metrics with declared labels only', async () => {
    metrics.providerCalls.inc({ provider: 'amadeus', capability: 'flights', outcome: 'ok' });
    metrics.providerCalls.inc({ provider: 'amadeus', capability: 'not a capability', outcome: 'exploded' });
    expect(registry.value('provider_calls_total', { capability: 'flights', outcome: 'ok' })).toBe(1);
    expect(registry.value('provider_calls_total', { capability: 'other', outcome: 'other' })).toBe(1);
    const text = await registry.render();
    expect(text).toContain('provider_calls_total{provider="amadeus",capability="flights",outcome="ok"} 1');
  });
});

describe('correlation', () => {
  it('carries identifiers through asynchronous work, and nests', async () => {
    expect(currentCorrelation()).toEqual({});
    await withCorrelation({ requestId: 'req-1' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(currentCorrelation()).toEqual({ requestId: 'req-1' });
      await withCorrelation({ runId: 'run-9', tripId: 'trip-2' }, async () => {
        await Promise.resolve();
        expect(currentCorrelation()).toEqual({ requestId: 'req-1', runId: 'run-9', tripId: 'trip-2' });
      });
      expect(currentCorrelation()).toEqual({ requestId: 'req-1' });
    });
    expect(currentCorrelation()).toEqual({});
  });

  it('keeps two concurrent flows apart', async () => {
    const seen: string[] = [];
    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        withCorrelation({ requestId: id }, async () => {
          await new Promise((r) => setTimeout(r, id === 'a' ? 5 : 1));
          seen.push(`${id}:${currentCorrelation().requestId}`);
        }),
      ),
    );
    expect(seen.sort()).toEqual(['a:a', 'b:b', 'c:c']);
  });

  it('accepts only identifiers, never text: anything else is dropped', () => {
    for (const bad of ['has space', 'a@b.c', '<x>', 'x'.repeat(65), '', '-leading', 'a\nb']) expect(safeId(bad)).toBeUndefined();
    for (const good of ['3f2b8a1e-0c4d-4b5e-9d7a-1a2b3c4d5e6f', 'req_1.2:3', 'run-9']) expect(safeId(good)).toBe(good);
    withCorrelation({ requestId: 'I want a cheap flight to Goa', runId: 'ok-1' }, () => {
      expect(currentCorrelation()).toEqual({ runId: 'ok-1' });
    });
  });
});

describe('error categories', () => {
  it('classify provider outcomes, and say that "nothing found" is not a fault', () => {
    expect(categoryOfProviderStatus('unavailable')).toBe('provider_unavailable');
    expect(categoryOfProviderStatus('timeout')).toBe('provider_timeout');
    expect(categoryOfProviderStatus('invalid_response')).toBe('provider_invalid_response');
    expect(categoryOfProviderStatus('rate_limited')).toBe('rate_limited');
    expect(categoryOfProviderStatus('not_configured')).toBe('provider_rejected');
    for (const fine of ['ok', 'no_availability', 'unsupported_route']) expect(categoryOfProviderStatus(fine)).toBeNull();
  });

  it.each([
    [200, undefined, null],
    [400, 'validation_failed', 'validation'],
    [401, 'unauthorized', 'authentication'],
    [403, 'bad_origin', 'authorization'],
    [404, 'not_found', 'not_found'],
    [409, 'trip_changed', 'conflict'],
    [413, 'payload_too_large', 'validation'],
    [429, 'rate_limited', 'rate_limited'],
    [500, 'internal_error', 'internal_error'],
    [501, 'booking_unavailable', 'unsupported'],
    [503, 'busy', 'queue_overloaded'],
    [503, 'provider_unavailable', 'provider_unavailable'],
    [503, 'email_delivery_failed', 'dependency_unavailable'],
  ] as const)('classify HTTP %i %s as %s', (status, code, category) => {
    expect(categoryOfHttp(status, code)).toBe(category);
  });

  it('classify what was thrown by name and shape, and everything unknown as internal', () => {
    const named = (name: string) => Object.assign(new Error('x'), { name });
    expect(categoryOfError(named('RequestAbortedError'))).toBe('cancelled');
    expect(categoryOfError(named('AbortError'))).toBe('cancelled');
    expect(categoryOfError(named('TimeoutError'))).toBe('provider_timeout');
    expect(categoryOfError(named('InvalidResponseError'))).toBe('provider_invalid_response');
    expect(categoryOfError(named('ZodError'))).toBe('validation');
    expect(categoryOfError(named('TripChangedError'))).toBe('conflict');
    expect(categoryOfError(named('LlmUnavailableError'))).toBe('dependency_unavailable');
    expect(categoryOfError(Object.assign(new Error('x'), { statusCode: 404, code: 'not_found' }))).toBe('not_found');
    expect(categoryOfError(new Error('boom'))).toBe('internal_error');
    expect(categoryOfError('a string')).toBe('internal_error');
    expect(categoryOfError(null)).toBe('internal_error');
  });

  it('is a closed list of unique names', () => {
    expect(new Set(ERROR_CATEGORIES).size).toBe(ERROR_CATEGORIES.length);
  });
});

describe('describing an error for a log', () => {
  afterEach(() => configureErrorDetail(true));

  it('says what kind, which category and where, and includes the message only if configured', () => {
    const err = Object.assign(new Error('the value "sam@example.com" is not a valid date'), { name: 'ZodError' });
    configureErrorDetail(false);
    const quiet = describeError(err);
    expect(quiet).toMatchObject({ errorType: 'ZodError', errorCategory: 'validation' });
    expect(quiet.errorFrames!.length).toBeGreaterThan(0);
    expect(quiet.errorMessage).toBeUndefined();
    // The frames say where, not what: the message is the stack's first line, and is not among them.
    expect(JSON.stringify(quiet)).not.toContain('sam@example.com');
    configureErrorDetail(true);
    expect(describeError(err).errorMessage).toContain('not a valid date');
  });

  it('copes with a thrown string, and cuts a very long message', () => {
    expect(describeError('boom')).toEqual({ errorType: 'string', errorCategory: 'internal_error' });
    expect(describeError(new Error('x'.repeat(2000))).errorMessage).toHaveLength(500);
  });
});

describe('what a span may carry', () => {
  it('keeps plain attributes and drops anything whose name says it holds a prompt, a body, a token or a person\'s words', () => {
    const kept = safeAttributes({
      provider: 'amadeus',
      'http.route': '/v1/trips/:id/plan',
      attempts: 3,
      cached: false,
      'llm.usage.in': 120,
      prompt: 'Book me a flight to Goa',
      'request.body': '{"x":1}',
      user_message: 'hello',
      utterance: 'cheaper please',
      cookie: 'tp_session=abc',
      'auth.token': 'abc',
      Authorization: 'Bearer x',
      apiKey: 'k',
      email: 'sam@example.com',
      password: 'p',
      answer_text: 'x',
    });
    expect(kept).toEqual({ provider: 'amadeus', 'http.route': '/v1/trips/:id/plan', attempts: 3, cached: false, 'llm.usage.in': 120 });
  });

  it('cuts long strings, and drops objects, arrays and non-finite numbers', () => {
    const kept = safeAttributes({ long: 'x'.repeat(500), obj: { a: 1 } as never, arr: [1] as never, nan: Number.NaN, none: undefined, nul: null });
    expect((kept['long'] as string).length).toBe(201);
    expect(Object.keys(kept)).toEqual(['long']);
  });
});

describe('spans', () => {
  async function tracing() {
    const exporter = memorySpanExporter();
    await setupTracing({ serviceName: 'test', environment: 'test', exporter });
    return exporter;
  }

  it('records a span with its attributes, its parent and its duration, and ends it', async () => {
    const exporter = await tracing();
    await withSpan('outer', { provider: 'x' }, async () => {
      await withSpan('inner', { capability: 'flights' }, async () => undefined);
    });
    const [inner, outer] = exporter.getFinishedSpans();
    expect(inner!.name).toBe('inner');
    expect(outer!.name).toBe('outer');
    expect(inner!.spanContext().traceId).toBe(outer!.spanContext().traceId);
    expect(inner!.parentSpanContext?.spanId).toBe(outer!.spanContext().spanId);
    expect(inner!.attributes['capability']).toBe('flights');
  });

  it('marks a failed span with the class and category of the error, never its message, and rethrows', async () => {
    const exporter = await tracing();
    const secret = 'sam@example.com asked for a refund with card 4111111111111111';
    await expect(withSpan('call', {}, async () => Promise.reject(Object.assign(new Error(secret), { name: 'TimeoutError' })))).rejects.toThrow(secret);
    const [span] = exporter.getFinishedSpans();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.attributes['error.category']).toBe('provider_timeout');
    expect(span!.attributes['error.type']).toBe('TimeoutError');
    const recorded = JSON.stringify({ name: span!.name, attributes: span!.attributes, events: span!.events, status: span!.status });
    expect(recorded).not.toContain('4111');
    expect(recorded).not.toContain('sam@example.com');
    expect(span!.events).toEqual([]); // no recorded exception
  });

  it('does not mark a cancellation as an error', async () => {
    const exporter = await tracing();
    await withSpan('call', {}, async () => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' }))).catch(() => undefined);
    const [span] = exporter.getFinishedSpans();
    expect(span!.status.code).toBe(SpanStatusCode.UNSET);
    expect(span!.attributes['error.category']).toBe('cancelled');
  });

  it('puts the correlation identifiers on every span, and events on the active one', async () => {
    const exporter = await tracing();
    await withCorrelation({ requestId: 'req-7', runId: 'run-7' }, () =>
      withSpan('work', {}, async () => {
        addSpanEvent('retry', { attempt: 2, reason: 'timeout', prompt: 'never' });
      }),
    );
    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes['trip.request_id']).toBe('req-7');
    expect(span!.attributes['trip.run_id']).toBe('run-7');
    expect(span!.events.map((e) => e.name)).toEqual(['retry']);
    expect(span!.events[0]!.attributes).toEqual({ attempt: 2, reason: 'timeout' });
  });

  it('puts the trace and span on log fields, and nothing when nothing is traced', async () => {
    expect(correlationFields()).toEqual({});
    await tracing();
    await withCorrelation({ requestId: 'req-1' }, () =>
      withSpan('x', {}, async () => {
        const fields = correlationFields();
        expect(fields['requestId']).toBe('req-1');
        expect(fields['traceId']).toMatch(/^[0-9a-f]{32}$/);
        expect(fields['spanId']).toMatch(/^[0-9a-f]{16}$/);
        expect(activeTraceIds()).toEqual({ traceId: fields['traceId'], spanId: fields['spanId'] });
      }),
    );
  });

  it('continues a trace begun elsewhere from its traceparent, which is how a queued run joins its request', async () => {
    const exporter = await tracing();
    let carried: string | null = null;
    await withSpan('http.request', {}, async () => {
      carried = activeTraceparent();
    });
    expect(validTraceparent(carried)).toBeDefined();
    await withSpan('planning.run', {}, async () => undefined, { parentTraceparent: carried! });
    const [request, run] = exporter.getFinishedSpans();
    expect(run!.spanContext().traceId).toBe(request!.spanContext().traceId);
    expect(run!.parentSpanContext?.spanId).toBe(request!.spanContext().spanId);
  });

  it('starts a fresh trace when the traceparent is malformed, rather than trusting it', async () => {
    const exporter = await tracing();
    for (const bad of ['garbage', '00-' + '0'.repeat(32) + '-' + '0'.repeat(16) + '-01', '00-xyz', '', '<script>']) {
      expect(validTraceparent(bad)).toBeUndefined();
      await withSpan('run', {}, async () => undefined, { parentTraceparent: bad });
    }
    const traces = new Set(exporter.getFinishedSpans().map((s) => s.spanContext().traceId));
    expect(traces.size).toBe(5);
  });

  it('gives identifiers to spans that are sampled out, so logs still correlate', async () => {
    const exporter = memorySpanExporter();
    await setupTracing({ serviceName: 'test', environment: 'test', exporter, sampleRatio: 0 });
    let ids: ReturnType<typeof activeTraceIds> = null;
    await withSpan('x', {}, async () => {
      ids = activeTraceIds();
    });
    expect(ids).not.toBeNull();
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it('works, recording nothing, when no SDK is installed', async () => {
    expect(await withSpan('x', { a: 1 }, async () => 42)).toBe(42);
    expect(activeTraceparent()).toBeNull();
  });
});

describe('the test harness', () => {
  beforeEach(() => resetMetrics());
  it('starts every test with empty metrics', () => {
    expect(registry.value('http_requests_total')).toBe(0);
  });
});
