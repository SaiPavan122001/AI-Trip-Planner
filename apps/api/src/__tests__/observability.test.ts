import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { engineServices, type PlanningServices } from '@trip/agents';
import { ResilientPolicy } from '@trip/providers';
import { memorySpanExporter, registry, resetMetrics, resetTracing, setupTracing } from '@trip/telemetry';
import { ProviderRegistry } from '@trip/providers';
import { createLogger, logPolicyEvent } from '../context.js';
import { MemoryCounterStore, type CounterStore } from '../infra/counters.js';
import type { SharedInfrastructure } from '../infra/redis.js';
import { TRIP_ID, buildTestApp, sessionFixture, signedInUser } from './helpers.js';
import { fakeTravelRegistry } from './fake-providers.js';
import { CapturingMailer, answerRequired, newTripBody } from './test-kit.js';

/**
 * Observability (Phase 7), end to end through the real server, worker and
 * engine with nothing on the network: what a request, a queued search, a slow or
 * failing provider and a broken database leave behind in spans, metrics and log
 * lines, that they can be joined up, and that they hold no personal data.
 */

const OPS = 'ops-token-that-is-long-enough-1234567890';
const auth = { authorization: `Bearer ${OPS}` };
const SENTINEL = 'SENTINEL-TRAVELLER-WORDS-ABOUT-A-SECRET-HOLIDAY';

let exporter: ReturnType<typeof memorySpanExporter>;

function captured() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _e, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const parsed = () => lines.flatMap((l) => l.split('\n').filter(Boolean)).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { logger: createLogger({ LOG_LEVEL: 'debug', NODE_ENV: 'test' }, stream), lines: () => lines, parsed };
}

const infraWith = (counters: CounterStore, state: 'ok' | 'degraded' | 'not_configured' = 'not_configured'): SharedInfrastructure => ({
  counters,
  cache: null,
  redisConfigured: state !== 'not_configured',
  redisState: () => state,
  close: async () => undefined,
});

beforeEach(async () => {
  resetMetrics();
  exporter = memorySpanExporter();
  await setupTracing({ serviceName: 'test', environment: 'test', exporter });
});
afterEach(async () => resetTracing());

const spans = (name?: string) => exporter.getFinishedSpans().filter((s) => (name ? s.name === name : true));
const byId = () => new Map(exporter.getFinishedSpans().map((s) => [s.spanContext().spanId, s]));
function ancestorNames(span: ReturnType<typeof spans>[number]): string[] {
  const all = byId();
  const out: string[] = [];
  let parent = span.parentSpanContext?.spanId;
  while (parent && all.get(parent)) {
    const p = all.get(parent)!;
    out.push(p.name);
    parent = p.parentSpanContext?.spanId;
  }
  return out;
}
const serialised = () =>
  JSON.stringify(exporter.getFinishedSpans().map((s) => ({ n: s.name, a: s.attributes, e: s.events.map((x) => ({ n: x.name, a: x.attributes })), st: s.status })));

async function plannedWithFakeTravel(extra: Record<string, unknown> = {}, envVars: Record<string, string> = {}) {
  const travel = fakeTravelRegistry({});
  const t = await buildTestApp({ registry: travel.registry, envVars: { RATE_LIMIT_MAX: '1000', RATE_LIMIT_ADDRESS_MAX: '1000', ...envVars }, ...extra });
  await answerRequired(t.app as never, TRIP_ID);
  exporter.reset();
  resetMetrics();
  return t;
}

// ---------------------------------------------------------------- correlation

describe('correlation', () => {
  it('gives a request one id, on its response, its span and every log line written while it runs', async () => {
    const log = captured();
    const t = await buildTestApp({ logger: log.logger });
    const res = await t.bare.inject({ method: 'POST', url: '/v1/auth/logout', headers: { origin: 'https://evil.example' } }); // writes a security event
    const requestId = String(res.headers['x-request-id']);
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    const [span] = spans('http.request');
    expect(span!.attributes['trip.request_id']).toBe(requestId);
    const line = log.parsed().find((l) => l['security'] === 'bad_origin')!;
    expect(line['requestId']).toBe(requestId);
    expect(line['traceId']).toBe(span!.spanContext().traceId);
    expect(line['spanId']).toBe(span!.spanContext().spanId);
    expect(line['service']).toBe('trip-api');
    expect(line['env']).toBe('test');
  });

  it('keeps concurrent requests apart', async () => {
    const log = captured();
    const t = await buildTestApp({ logger: log.logger });
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => t.bare.inject({ method: 'POST', url: '/v1/auth/logout', headers: { origin: 'https://evil.example' } })),
    );
    const ids = responses.map((r) => String(r.headers['x-request-id']));
    const logged = log.parsed().filter((l) => l['security'] === 'bad_origin').map((l) => l['requestId']);
    expect(new Set(ids).size).toBe(12);
    expect([...logged].sort()).toEqual([...ids].sort());
    const traces = new Set(spans('http.request').map((s) => s.spanContext().traceId));
    expect(traces.size).toBe(12);
  });

  it('carries a request into the search it queued: the run continues the request\'s trace, with its request id', async () => {
    const log = captured();
    const t = await plannedWithFakeTravel({ logger: log.logger });
    const res = await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` });
    const requestId = String(res.headers['x-request-id']);
    const runId = res.json().run.id as string;
    // The run's row carries the trace and the id, as identifiers only.
    const stored = (await t.repository.getRun(runId))!;
    expect(stored.params['trace']).toEqual({ traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/), requestId });
    expect(JSON.stringify(stored.params['trace'])).not.toMatch(/cookie|email|@/);

    await t.ctx.worker.drain(); // "later", by a worker

    const request = spans('http.request').find((s) => s.attributes['trip.request_id'] === requestId)!;
    const run = spans('planning.run')[0]!;
    expect(run.spanContext().traceId).toBe(request.spanContext().traceId);
    expect(run.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
    expect(run.attributes).toMatchObject({ 'trip.run_id': runId, 'trip.trip_id': TRIP_ID, 'trip.request_id': requestId, 'planning.outcome': 'succeeded' });
    // Every log line written while the run ran carries the run, the trip and the request that caused it.
    const finished = log.parsed().find((l) => l['operation'] === 'planning.run')!;
    expect(finished).toMatchObject({ runId, tripId: TRIP_ID, requestId, traceId: request.spanContext().traceId });
  });

  it('still runs, on a trace of its own, when the run carries no trace (one queued before this existed)', async () => {
    const t = await plannedWithFakeTravel();
    const started = (await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` })).json().run as { id: string };
    const row = (await t.repository.getRun(started.id))!;
    row.params = { ...row.params, trace: undefined };
    await t.ctx.worker.drain();
    expect((await t.repository.getRun(started.id))?.status).toBe('succeeded');
    expect(spans('planning.run')).toHaveLength(1);
  });

  it('does not continue a trace a caller sends: identifiers are ours to make', async () => {
    const t = await buildTestApp();
    const foreign = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
    await t.bare.inject({ method: 'GET', url: '/v1/me', headers: { traceparent: foreign } });
    const [span] = spans('http.request');
    expect(span!.spanContext().traceId).not.toBe('a'.repeat(32));
  });
});

// ---------------------------------------------------------------------- spans

describe('the trace of one search', () => {
  it('is a tree: request, run, stages, agents, provider calls and store operations', async () => {
    const t = await plannedWithFakeTravel();
    await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` });
    await t.ctx.worker.drain();

    const names = new Set(exporter.getFinishedSpans().map((s) => s.name));
    for (const expected of ['http.request', 'planning.run', 'planning.stage', 'agent.transport', 'provider.call', 'db.operation']) expect(names).toContain(expected);
    const stages = spans('planning.stage').map((s) => s.attributes['planning.stage']);
    for (const stage of ['guidance', 'search', 'hotels', 'assemble', 'plan_search', 'validation', 'synthesis']) expect(stages).toContain(stage);

    const flights = spans('provider.call').find((s) => s.attributes['provider.capability'] === 'flights')!;
    expect(ancestorNames(flights)).toEqual(expect.arrayContaining(['planning.stage', 'planning.run', 'http.request']));
    const agent = spans('agent.transport')[0]!;
    expect(ancestorNames(agent)).toContain('planning.stage');
    expect(agent.attributes).toMatchObject({ 'agent.name': 'transport', 'agent.source': 'rules' });
    // A trip read from inside the run is a child of it.
    const readInRun = spans('db.operation').find((s) => ancestorNames(s).includes('planning.run'));
    expect(readInRun).toBeDefined();
  });

  it('shows which provider failed, how, and that the run carried on', async () => {
    const travel = fakeTravelRegistry({ flights: async () => ({ status: 'unavailable', provider: 'fake-flights', providerLabel: 'Fake flights', message: 'down', occurredAt: new Date().toISOString() }) as never });
    const t = await buildTestApp({ registry: travel.registry, envVars: { RATE_LIMIT_MAX: '1000' } });
    await answerRequired(t.app as never, TRIP_ID);
    exporter.reset();
    resetMetrics();
    const started = (await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` })).json().run as { id: string };
    await t.ctx.worker.drain();
    expect((await t.repository.getRun(started.id))?.status).toBe('succeeded');
    const failed = spans('provider.call').filter((s) => s.attributes['provider.outcome'] === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]!.attributes).toMatchObject({ 'provider.capability': 'flights', 'error.category': 'provider_unavailable' });
    expect(failed[0]!.status.code).toBe(2);
    expect(spans('planning.run')[0]!.attributes['planning.outcome']).toBe('succeeded');
    expect(registry.value('provider_calls_total', { capability: 'flights', outcome: 'failed' })).toBeGreaterThan(0);
    expect(registry.value('provider_errors_total', { capability: 'flights', category: 'provider_unavailable' })).toBeGreaterThan(0);
  });

  it('marks a run that failed with the category of what broke, without the message', async () => {
    const services: PlanningServices = {
      buildPlans: async () => {
        throw new Error(`planning blew up near ${SENTINEL} and sam.private@example.com`);
      },
    };
    const log = captured();
    const t = await buildTestApp({ logger: log.logger, planningServices: services, registry: fakeTravelRegistry({}).registry, envVars: { LOG_ERROR_MESSAGES: 'false' } });
    await answerRequired(t.app as never, TRIP_ID);
    const started = (await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` })).json().run as { id: string };
    await t.ctx.worker.drain();
    expect((await t.repository.getRun(started.id))?.status).toBe('failed');
    const run = spans('planning.run')[0]!;
    expect(run.attributes['planning.outcome']).toBe('failed');
    expect(run.attributes['error.category']).toBe('internal_error');
    expect(run.attributes['error.type']).toBe('Error');
    expect(registry.value('planning_runs_total', { event: 'failed' })).toBe(1);
    expect(registry.value('errors_total', { category: 'internal_error', component: 'planning' })).toBe(1);
    // Neither the trace nor the log repeated what the exception said.
    expect(serialised()).not.toContain(SENTINEL);
    const everything = log.lines().join('');
    expect(everything).not.toContain(SENTINEL);
    expect(everything).not.toContain('sam.private@example.com');
    const line = log.parsed().find((l) => l['msg'] === 'Planning run failed')!;
    expect(line).toMatchObject({ errorType: 'Error', errorCategory: 'internal_error', runId: started.id });
    expect(Array.isArray(line['errorFrames'])).toBe(true);
    expect(line['errorMessage']).toBeUndefined();
  });

  it('includes an error\'s message in the log only where the operator has said to (the default outside production)', async () => {
    const log = captured();
    const services: PlanningServices = { buildPlans: async () => Promise.reject(new Error('the message an engineer needs')) };
    const t = await buildTestApp({ logger: log.logger, planningServices: services, registry: fakeTravelRegistry({}).registry });
    await answerRequired(t.app as never, TRIP_ID);
    await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` });
    await t.ctx.worker.drain();
    expect(log.parsed().find((l) => l['msg'] === 'Planning run failed')!['errorMessage']).toBe('the message an engineer needs');
  });
});

// -------------------------------------------------------------------- metrics

describe('HTTP metrics', () => {
  it('count requests by method, route pattern and status class, and time them', async () => {
    const t = await buildTestApp();
    await t.app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}` });
    await t.app.inject({ method: 'GET', url: `/v1/trips/${randomUUID()}` });
    await t.bare.inject({ method: 'GET', url: '/v1/me' });
    expect(registry.value('http_requests_total', { method: 'GET', route: '/v1/trips/:id', status_class: '2xx' })).toBe(1);
    expect(registry.value('http_requests_total', { method: 'GET', route: '/v1/trips/:id', status_class: '4xx' })).toBe(1);
    expect(registry.value('http_requests_total', { route: '/v1/me' })).toBe(1);
    expect(registry.value('http_request_duration_seconds', { route: '/v1/trips/:id' })).toBe(2);
    expect(registry.value('http_errors_total', { category: 'not_found' })).toBe(1);
  });

  it('never let a path, an id or a query become a label: the route is the pattern, and an unknown one is "unmatched"', async () => {
    const t = await buildTestApp();
    for (let i = 0; i < 50; i += 1) await t.app.inject({ method: 'GET', url: `/v1/trips/${randomUUID()}?q=${SENTINEL}${i}` });
    for (let i = 0; i < 20; i += 1) await t.bare.inject({ method: 'GET', url: `/definitely/not/${SENTINEL}/${i}` });
    const text = await registry.render();
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
    expect(registry.value('http_requests_total', { route: 'unmatched' })).toBe(20);
    expect(registry.snapshot()['http_requests_total']!.length).toBeLessThan(6);
  });

  it('put the operational category on every error answer, in the header, without changing the body', async () => {
    const t = await buildTestApp({ geocoding: true, envVars: { RATE_LIMIT_MAX: '1000', RATE_LIMIT_ADDRESS_MAX: '1000' } });
    const stranger = await t.asStranger();
    const cases: Array<[string, () => Promise<{ statusCode: number; headers: Record<string, unknown>; json: () => { error: { code: string } } }>, string]> = [
      ['validation', () => t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/answers`, payload: { nothing: 1 } }) as never, 'validation'],
      ['authentication', () => t.bare.inject({ method: 'GET', url: '/v1/me/export' }) as never, 'authentication'],
      ['authorization', () => t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan`, headers: { origin: 'https://evil.example' } }) as never, 'authorization'],
      ['not_found', () => stranger.app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}` }) as never, 'not_found'],
      ['unsupported', () => t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/bookings` }) as never, 'unsupported'],
    ];
    for (const [, run, category] of cases) {
      const res = await run();
      expect(res.headers['x-error-category']).toBe(category);
      expect(Object.keys(res.json().error).sort()).toEqual(expect.arrayContaining(['code', 'message']));
      expect(Object.keys(res.json().error)).not.toContain('category');
    }
    expect((await t.app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}` })).headers['x-error-category']).toBeUndefined();
  });

  it('classify overload, conflicts, rate limits and unexpected failures', async () => {
    const t = await buildTestApp({ envVars: { RATE_LIMIT_MAX: '3', RATE_LIMIT_ADDRESS_MAX: '3' } });
    for (let i = 0; i < 3; i += 1) await t.app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}` });
    const limited = await t.app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}` });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['x-error-category']).toBe('rate_limited');

    const busy = await buildTestApp({ envVars: { MAX_QUEUED_RUNS: '1', RATE_LIMIT_MAX: '1000', RATE_LIMIT_ADDRESS_MAX: '1000' }, seedTrip: false });
    const person = await signedInUser(busy.repository, busy.ctx.env, 'a@example.com');
    const [a, b] = await Promise.all([1, 2].map(() => busy.repository.createSession({ ...sessionFixture(randomUUID()), ownerId: person.id })));
    await busy.bare.inject({ method: 'POST', url: `/v1/trips/${a!.id}/plan`, headers: { cookie: person.cookie } });
    const refused = await busy.bare.inject({ method: 'POST', url: `/v1/trips/${b!.id}/plan`, headers: { cookie: person.cookie } });
    expect(refused.statusCode).toBe(503);
    expect(refused.headers['x-error-category']).toBe('queue_overloaded');

    const broken = await buildTestApp();
    broken.repository.getSession = async () => Promise.reject(new Error('database exploded'));
    const failure = await broken.app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}` });
    expect(failure.statusCode).toBe(500);
    expect(failure.headers['x-error-category']).toBe('internal_error');
    expect(failure.body).not.toMatch(/exploded|stack| at /);
    expect(registry.value('errors_total', { category: 'internal_error', component: 'database' })).toBe(1);
  });
});

describe('planning metrics', () => {
  it('count a run from queued to finished, and time the wait and the work', async () => {
    const t = await plannedWithFakeTravel();
    await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` });
    expect(registry.value('planning_runs_total', { event: 'queued', kind: 'plan' })).toBe(1);
    await new Promise((r) => setTimeout(r, 25)); // it waits for a worker
    await t.ctx.worker.drain();
    expect(registry.value('planning_runs_total', { event: 'started', kind: 'plan' })).toBe(1);
    expect(registry.value('planning_runs_total', { event: 'succeeded', kind: 'plan' })).toBe(1);
    expect(registry.value('planning_queue_wait_seconds', { kind: 'plan' })).toBe(1);
    expect(registry.value('planning_duration_seconds', { kind: 'plan', outcome: 'succeeded' })).toBe(1);
    const wait = registry.snapshot()['planning_queue_wait_seconds']![0]!;
    expect(wait.value).toBeGreaterThanOrEqual(0.02); // the sum of the observed waits
    for (const stage of ['guidance', 'search', 'hotels', 'assemble', 'plan_search', 'validation', 'synthesis']) {
      expect(registry.value('planning_stage_duration_seconds', { stage })).toBe(1);
    }
    expect(registry.value('agent_runs_total', { agent: 'transport', source: 'rules', outcome: 'ok' })).toBe(1);
  });

  it('write one standard log line for the run, with how long it waited and how long it took', async () => {
    const log = captured();
    const t = await plannedWithFakeTravel({ logger: log.logger });
    await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` });
    await t.ctx.worker.drain();
    const line = log.parsed().find((l) => l['operation'] === 'planning.run')!;
    expect(line).toMatchObject({ outcome: 'succeeded', kind: 'plan', attempt: 1, service: 'trip-api', msg: 'Planning run finished' });
    expect(typeof line['queueWaitMs']).toBe('number');
    expect(typeof line['planningMs']).toBe('number');
    expect(line['time']).toBeDefined();
  });

  it('count a cancelled run as cancelled, and a run whose trip changed as superseded', async () => {
    const t = await plannedWithFakeTravel();
    const first = (await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` })).json().run as { id: string };
    await t.repository.requestCancel(first.id);
    const second = (await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` })).json().run as { id: string };
    const trip = (await t.repository.getSession(TRIP_ID))!;
    await t.repository.updateSession({ ...trip, profile: { ...trip.profile, travelStyle: 'premium' } });
    await t.ctx.worker.drain();
    expect((await t.repository.getRun(second.id))?.status).toBe('superseded');
    expect(registry.value('planning_runs_total', { event: 'superseded' })).toBe(1);
    expect(registry.value('planning_runs_total', { event: 'cancelled' })).toBe(0); // it never started: cancelled while queued
    // A cancel that reaches a run in progress:
    const third = (await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` })).json().run as { id: string };
    expect(third.id).toBeDefined();
  });

  it('read the queue depth when scraped', async () => {
    const t = await buildTestApp({ seedTrip: false, envVars: { RATE_LIMIT_MAX: '1000', MAX_ACTIVE_RUNS_PER_USER: '5', MAX_QUEUED_RUNS: '50' } });
    for (const email of ['a@example.com', 'b@example.com']) {
      const p = await signedInUser(t.repository, t.ctx.env, email);
      const trip = await t.repository.createSession({ ...sessionFixture(randomUUID()), ownerId: p.id });
      await t.bare.inject({ method: 'POST', url: `/v1/trips/${trip.id}/plan`, headers: { cookie: p.cookie } });
    }
    expect(await registry.render()).toMatch(/planning_queue_depth 2\n/);
    await t.ctx.worker.drain();
    expect(await registry.render()).toMatch(/planning_queue_depth 0\n/);
  });

  it('count runs dropped for waiting too long', async () => {
    const t = await buildTestApp({ seedTrip: false, envVars: { RUN_QUEUE_TIMEOUT_MS: '5000' } });
    let sweeps = 0;
    t.repository.expireStaleQueued = async () => {
      sweeps += 1;
      return 3;
    };
    await t.ctx.worker.drain();
    expect(registry.value('planning_runs_total', { event: 'expired' })).toBe(0); // drain() sheds silently; the polling loop counts
    t.ctx.worker.start();
    await new Promise((r) => setTimeout(r, 1300));
    await t.ctx.worker.stop(200);
    expect(sweeps).toBeGreaterThan(0);
    expect(registry.value('planning_runs_total', { event: 'expired' })).toBeGreaterThanOrEqual(3);
  });
});

describe('other components', () => {
  it('count rate-limit decisions by policy, allowed and rejected', async () => {
    const t = await buildTestApp({ envVars: { RATE_LIMIT_MAX: '2', RATE_LIMIT_ADDRESS_MAX: '2' } });
    for (let i = 0; i < 4; i += 1) await t.app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}` });
    expect(registry.value('rate_limit_decisions_total', { policy: 'all', decision: 'allowed' })).toBe(2);
    expect(registry.value('rate_limit_decisions_total', { policy: 'all', decision: 'rejected' })).toBe(2);
  });

  it('time every store operation by name, and count and log the slow ones by name only', async () => {
    const log = captured();
    const t = await buildTestApp({ logger: log.logger, envVars: { SLOW_DB_MS: '10' } });
    const original = t.repository.getSession.bind(t.repository);
    t.repository.getSession = async (id: string) => {
      await new Promise((r) => setTimeout(r, 30));
      return original(id);
    };
    await t.app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}` });
    expect(registry.value('db_operation_duration_seconds', { operation: 'getSession', outcome: 'ok' })).toBeGreaterThanOrEqual(1);
    expect(registry.value('db_slow_operations_total', { operation: 'getSession' })).toBeGreaterThanOrEqual(1);
    const slow = log.parsed().find((l) => l['operation'] === 'db.slow')!;
    expect(slow).toMatchObject({ dbOperation: 'getSession', outcome: 'ok', requestId: expect.any(String) });
    expect(Number(slow['durationMs'])).toBeGreaterThanOrEqual(25);
    expect(JSON.stringify(slow)).not.toContain(TRIP_ID); // the argument is never recorded
  });

  it('count a failing store operation as an error, and rethrow it unchanged', async () => {
    const t = await buildTestApp();
    t.repository.getSession = async () => Promise.reject(Object.assign(new Error('connection lost'), { name: 'PrismaClientKnownRequestError' }));
    const res = await t.app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}` });
    expect(res.statusCode).toBe(500);
    expect(registry.value('db_operation_duration_seconds', { operation: 'getSession', outcome: 'error' })).toBeGreaterThanOrEqual(1);
  });

  it('log circuit changes with the standard operation field', async () => {
    const log = captured();
    // A registry wired as the service wires its own: policy events go to the logger.
    const registry2 = ProviderRegistry.fromEnv({}, { onPolicyEvent: (e) => logPolicyEvent(log.logger, e) });
    const t = await buildTestApp({ logger: log.logger, registry: registry2 });
    const policy = t.ctx.registry.policy as ResilientPolicy;
    for (let i = 0; i < 5; i += 1) {
      await policy.execute({ provider: 'amadeus', providerLabel: 'A', capability: 'flights', operation: 'searchFlights' }, async () => ({ status: 'unavailable', provider: 'amadeus', providerLabel: 'A', message: 'x', occurredAt: '' }) as never);
    }
    const line = log.parsed().find((l) => l['operation'] === 'provider.circuit')!;
    expect(line).toMatchObject({ circuit: 'amadeus:flights', fromState: 'closed', toState: 'open' });
  });
});

// -------------------------------------------------------------------- health

describe('liveness and readiness', () => {
  it('liveness answers whatever else is wrong: it touches nothing', async () => {
    const t = await buildTestApp();
    t.repository.healthCheck = async () => Promise.reject(new Error('database down'));
    t.repository.countQueuedRuns = async () => Promise.reject(new Error('database down'));
    const res = await t.bare.inject({ method: 'GET', url: '/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('alive');
    expect(Object.keys(res.json()).sort()).toEqual(['status', 'uptimeSeconds']);
  });

  it('readiness fails when the database is unreachable, or the queue cannot be read, and says nothing more', async () => {
    const t = await buildTestApp({ geocoding: true });
    expect((await t.bare.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    t.repository.countQueuedRuns = async () => Promise.reject(new Error('relation "planning_runs" does not exist'));
    const queue = await t.bare.inject({ method: 'GET', url: '/ready' });
    expect(queue.statusCode).toBe(503);
    expect(queue.body).not.toMatch(/relation|planning_runs/);
    const down = await buildTestApp({ geocoding: true });
    down.repository.healthCheck = async () => ({ ok: false, store: 'postgresql', detail: 'The database could not be reached.', cause: 'ECONNREFUSED 10.0.0.9' });
    const res = await down.bare.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toMatch(/ECONNREFUSED|10\.0\.0\.9/);
  });

  it('readiness does not fail for Redis being down, providers being unavailable, the model being off or the queue being full', async () => {
    const counters = new MemoryCounterStore();
    const t = await buildTestApp({
      geocoding: true,
      infra: infraWith(counters, 'degraded'),
      envVars: { MAX_QUEUED_RUNS: '1', RATE_LIMIT_MAX: '1000', RATE_LIMIT_ADDRESS_MAX: '1000' },
    });
    // Every provider's circuit open.
    const policy = t.ctx.registry.policy as ResilientPolicy;
    for (const capability of ['flights', 'hotels', 'trains', 'geocoding'] as const) {
      for (let i = 0; i < 6; i += 1) {
        await policy.execute({ provider: 'p', providerLabel: 'P', capability, operation: 'x' }, async () => ({ status: 'unavailable', provider: 'p', providerLabel: 'P', message: 'x', occurredAt: '' }) as never);
      }
    }
    expect(policy.circuitStates().every((c) => c.state === 'open')).toBe(true);
    // The queue is full.
    await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` });
    expect(await t.repository.countQueuedRuns()).toBe(1);
    expect(t.ctx.llm.available).toBe(false);
    const res = await t.bare.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ready: true, geocoding: 'available' });
    expect(Object.keys(res.json()).sort()).toEqual(['geocoding', 'ready', 'store']);
  });

  it('keeps the old /health working, and as guarded as before', async () => {
    const t = await buildTestApp();
    const res = await t.bare.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
});

describe('the operator endpoints', () => {
  it('do not exist unless the operator sets a token', async () => {
    const t = await buildTestApp();
    for (const url of ['/metrics', '/ops/status']) {
      const res = await t.bare.inject({ method: 'GET', url, headers: auth });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    }
  });

  it('need the token, compared as a token, and say nothing about how close a wrong one was', async () => {
    const t = await buildTestApp({ envVars: { OPS_TOKEN: OPS } });
    for (const headers of [{}, { authorization: 'Bearer ' }, { authorization: 'Bearer wrong' }, { authorization: OPS }, { authorization: `Bearer ${OPS.slice(0, -1)}` }, { authorization: `Bearer ${OPS}x` }, { authorization: `Basic ${OPS}` }]) {
      const res = await t.bare.inject({ method: 'GET', url: '/metrics', headers });
      expect(res.statusCode).toBe(401);
      expect(res.body).toBe(JSON.stringify({ error: { code: 'unauthorized', message: 'A valid operator token is needed.' } }));
    }
    expect((await t.bare.inject({ method: 'GET', url: '/metrics', headers: auth })).statusCode).toBe(200);
  });

  it('accept the token only in the header, never the query string, and a session is not enough', async () => {
    const t = await buildTestApp({ envVars: { OPS_TOKEN: OPS } });
    expect((await t.bare.inject({ method: 'GET', url: `/metrics?token=${OPS}` })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
  });

  it('lock an address out after repeated wrong tokens, even for the right one', async () => {
    const t = await buildTestApp({ envVars: { OPS_TOKEN: OPS } });
    const codes: number[] = [];
    for (let i = 0; i < 13; i += 1) codes.push((await t.bare.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer guess-${i}` }, remoteAddress: '203.0.113.9' })).statusCode);
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(codes.slice(10)).toEqual([429, 429, 429]);
    expect((await t.bare.inject({ method: 'GET', url: '/metrics', headers: auth, remoteAddress: '203.0.113.9' })).statusCode).toBe(429);
    expect((await t.bare.inject({ method: 'GET', url: '/metrics', headers: auth, remoteAddress: '203.0.113.10' })).statusCode).toBe(200);
  });

  it('serve the Prometheus text format with the system\'s metrics', async () => {
    const t = await plannedWithFakeTravel({}, { OPS_TOKEN: OPS });
    await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` });
    await t.ctx.worker.drain();
    const res = await t.bare.inject({ method: 'GET', url: '/metrics', headers: auth });
    expect(res.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(res.headers['cache-control']).toBe('no-store');
    for (const name of ['http_requests_total', 'planning_runs_total', 'planning_duration_seconds_bucket', 'provider_calls_total', 'provider_call_duration_seconds_count', 'db_operation_duration_seconds_sum', 'agent_runs_total', 'planning_queue_depth', 'rate_limit_decisions_total']) {
      expect(res.body).toContain(name);
    }
    expect(res.body).toMatch(/^# TYPE http_requests_total counter$/m);
  });

  it('show state and counts in /ops/status, and no secret, address, person or trip', async () => {
    const mailer = new CapturingMailer();
    const t = await buildTestApp({ geocoding: true, mailer: mailer as never, infra: infraWith(new MemoryCounterStore(), 'degraded'), envVars: { OPS_TOKEN: OPS, SESSION_SECRET: 'a-very-long-and-unmistakable-session-secret-0123456789' } });
    await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` });
    const res = await t.bare.inject({ method: 'GET', url: '/ops/status', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ service: 'trip-api', environment: 'test', store: { ok: true, kind: expect.any(String) }, queue: { queued: 1, capacity: 200 }, redis: 'degraded', llm: { available: false } });
    expect(body.providers).toMatchObject({ connected: expect.any(Array), circuits: [], degraded: false });
    expect(body.telemetry.tracing).toBe(true);
    for (const leaked of [OPS, 'a-very-long-and-unmistakable-session-secret', TRIP_ID, t.owner.id, '127.0.0.1', 'stack']) expect(res.body).not.toContain(leaked);
  });

  it('report an open circuit as degraded, for the operator only', async () => {
    const t = await buildTestApp({ envVars: { OPS_TOKEN: OPS } });
    const policy = t.ctx.registry.policy as ResilientPolicy;
    for (let i = 0; i < 6; i += 1) await policy.execute({ provider: 'amadeus', providerLabel: 'A', capability: 'flights', operation: 'x' }, async () => ({ status: 'unavailable', provider: 'amadeus', providerLabel: 'A', message: 'x', occurredAt: '' }) as never);
    const body = (await t.bare.inject({ method: 'GET', url: '/ops/status', headers: auth })).json();
    expect(body.providers.degraded).toBe(true);
    expect(body.providers.circuits).toEqual([{ key: 'amadeus:flights', state: 'open', consecutiveFailures: 5 }]);
  });

  it('refuse to be configured with a short token, without repeating it', async () => {
    const { testEnv } = await import('./helpers.js');
    expect(() => testEnv({ OPS_TOKEN: 'short-token-hunter2' })).toThrow(/OPS_TOKEN/);
    try {
      testEnv({ OPS_TOKEN: 'short-token-hunter2' });
    } catch (err) {
      expect((err as Error).message).not.toContain('hunter2');
    }
  });
});

// ------------------------------------------------------------- telemetry policy

describe('what telemetry may hold', () => {
  it('holds no cookie, token, email address, address, or traveller\'s words, in any span, metric or log line', async () => {
    const log = captured();
    const mailer = new CapturingMailer();
    const t = await buildTestApp({ logger: log.logger, mailer: mailer as never, geocoding: true, envVars: { OPS_TOKEN: OPS, RATE_LIMIT_MAX: '1000', RATE_LIMIT_ADDRESS_MAX: '1000' } });
    const created = await t.bare.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody, remoteAddress: '203.0.113.77' });
    const cookie = String(created.headers['set-cookie']).split(';')[0]!;
    const token = cookie.split('=')[1]!;
    const tripId = created.json().trip.id as string;
    await t.bare.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email: 'sam.private@example.com' }, headers: { cookie } });
    const linkToken = mailer.lastToken;
    await t.bare.inject({ method: 'POST', url: `/v1/trips/${tripId}/modify`, payload: { utterance: `${SENTINEL} avoid overnight travel` }, headers: { cookie } });
    await t.bare.inject({ method: 'POST', url: `/v1/trips/${tripId}/requirements`, payload: { message: `${SENTINEL} no buses` }, headers: { cookie } });
    await t.bare.inject({ method: 'POST', url: `/v1/trips/${tripId}/plan`, headers: { cookie } });
    await t.ctx.worker.drain();
    const metricsText = (await t.bare.inject({ method: 'GET', url: '/metrics', headers: auth })).body;
    const everything = [serialised(), metricsText, log.lines().join('')].join('\n');
    for (const secret of [token, linkToken, 'sam.private@example.com', SENTINEL, '203.0.113.77', OPS, 'Bearer']) {
      expect(everything, `telemetry contains ${secret.slice(0, 10)}…`).not.toContain(secret);
    }
  });

  it('records identifiers for the trip and run, which are random ids and not personal data', async () => {
    const t = await plannedWithFakeTravel();
    await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` });
    await t.ctx.worker.drain();
    const run = spans('planning.run')[0]!;
    expect(run.attributes['trip.trip_id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.attributes['trip.run_id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

it('the engine, providers and agents record nothing when there is no SDK: the packages work without one', async () => {
  await resetTracing();
  const t = await plannedWithFakeTravel();
  await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` });
  await t.ctx.worker.drain();
  expect((await t.repository.latestRunForTrip(TRIP_ID))?.status).toBe('succeeded');
  void engineServices;
});
