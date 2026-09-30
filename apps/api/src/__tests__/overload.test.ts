import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { engineServices, type PlanningServices } from '@trip/agents';
import { ApiError } from '../errors.js';
import { TripChangedError } from '../repository/types.js';
import { TRIP_ID, buildTestApp, sessionFixture, signedInUser } from './helpers.js';
import { fakeTravelRegistry } from './fake-providers.js';
import { answerRequired } from './test-kit.js';

/**
 * Overload, resource limits and failing infrastructure (Phase 5.6, 5.8, 5.11).
 *
 * What is held to: under more work than the service can do it says so, at once
 * and plainly, instead of accepting work it will drop or letting the amount
 * grow without limit; and when the database or a provider misbehaves it
 * fails safely, with nothing internal in the answer and nothing half-done in
 * the trip.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Puts a person and a trip of theirs in the store, and returns how to act as them. */
async function personWithTrips(t: Awaited<ReturnType<typeof buildTestApp>>, count: number, email: string | null = null) {
  const person = await signedInUser(t.repository, t.ctx.env, email);
  const trips = await Promise.all(
    Array.from({ length: count }, () => t.repository.createSession({ ...sessionFixture(randomUUID()), ownerId: person.id })),
  );
  const plan = (tripId: string) => t.bare.inject({ method: 'POST', url: `/v1/trips/${tripId}/plan`, headers: { cookie: person.cookie } });
  return { person, trips, plan };
}

describe('a full queue', () => {
  it('turns new searches away at once, with a time to come back, and creates nothing', async () => {
    const t = await buildTestApp({ seedTrip: false, envVars: { MAX_QUEUED_RUNS: '2', MAX_ACTIVE_RUNS_PER_USER: '9', RATE_LIMIT_MAX: '1000' } });
    // Two other people's searches are already waiting for a worker.
    for (const email of ['a@example.com', 'b@example.com']) {
      const other = await personWithTrips(t, 1, email);
      expect((await other.plan(other.trips[0]!.id)).statusCode).toBe(202);
    }
    expect(await t.repository.countQueuedRuns()).toBe(2);

    const me = await personWithTrips(t, 1, 'me@example.com');
    const res = await me.plan(me.trips[0]!.id);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('busy');
    expect(res.headers['retry-after']).toBe('30');
    expect(res.json().error.message).toMatch(/Nothing was lost/);
    expect(await t.repository.activeRunForTrip(me.trips[0]!.id)).toBeNull();
    expect(await t.repository.countQueuedRuns()).toBe(2); // the queue did not grow
  });

  it('takes work again as soon as there is room', async () => {
    const t = await buildTestApp({ seedTrip: false, envVars: { MAX_QUEUED_RUNS: '1', RATE_LIMIT_MAX: '1000' } });
    const first = await personWithTrips(t, 1, 'a@example.com');
    const started = (await first.plan(first.trips[0]!.id)).json().run as { id: string };
    const second = await personWithTrips(t, 1, 'b@example.com');
    expect((await second.plan(second.trips[0]!.id)).statusCode).toBe(503);
    await t.repository.requestCancel(started.id);
    expect((await second.plan(second.trips[0]!.id)).statusCode).toBe(202);
  });

  it('does not refuse a repeat of a search that already holds a place in the queue', async () => {
    const t = await buildTestApp({ seedTrip: false, envVars: { MAX_QUEUED_RUNS: '1', RATE_LIMIT_MAX: '1000' } });
    const me = await personWithTrips(t, 1, 'me@example.com');
    const first = await me.plan(me.trips[0]!.id);
    const again = await me.plan(me.trips[0]!.id);
    expect(first.statusCode).toBe(202);
    expect(again.statusCode).toBe(202);
    expect(again.json().reused).toBe(true);
  });
});

describe('one person cannot take every worker', () => {
  it('stops at the number of searches they may have going at once, across all their trips', async () => {
    const t = await buildTestApp({ seedTrip: false, envVars: { MAX_ACTIVE_RUNS_PER_USER: '2', RATE_LIMIT_MAX: '1000' } });
    const me = await personWithTrips(t, 4, 'me@example.com');
    const [a, b, c] = me.trips;
    expect((await me.plan(a!.id)).statusCode).toBe(202);
    expect((await me.plan(b!.id)).statusCode).toBe(202);
    const refused = await me.plan(c!.id);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe('too_many_active_searches');
    expect(refused.json().error.message).toMatch(/stop one/);
    // Stopping one makes room.
    const run = await t.repository.activeRunForTrip(a!.id);
    await t.repository.requestCancel(run!.id);
    expect((await me.plan(c!.id)).statusCode).toBe(202);
  });

  it('does not let one person\'s searches count against another\'s', async () => {
    const t = await buildTestApp({ seedTrip: false, envVars: { MAX_ACTIVE_RUNS_PER_USER: '1', RATE_LIMIT_MAX: '1000' } });
    const a = await personWithTrips(t, 1, 'a@example.com');
    const b = await personWithTrips(t, 1, 'b@example.com');
    expect((await a.plan(a.trips[0]!.id)).statusCode).toBe(202);
    expect((await b.plan(b.trips[0]!.id)).statusCode).toBe(202);
  });
});

describe('work is bounded', () => {
  it('never runs more searches at once than the worker is set to', async () => {
    let running = 0;
    let most = 0;
    const services: PlanningServices = {
      buildPlans: async (deps) => {
        running += 1;
        most = Math.max(most, running);
        await sleep(40);
        try {
          return await engineServices.buildPlans(deps);
        } finally {
          running -= 1;
        }
      },
    };
    const travel = fakeTravelRegistry({});
    const t = await buildTestApp({ seedTrip: false, registry: travel.registry, planningServices: services, envVars: { RUN_CONCURRENCY: '2', RUN_POLL_MS: '50', MAX_QUEUED_RUNS: '50', RATE_LIMIT_MAX: '1000' } });
    const runs: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const p = await personWithTrips(t, 1, `p${i}@example.com`);
      runs.push(((await p.plan(p.trips[0]!.id)).json().run as { id: string }).id);
    }
    t.ctx.worker.start();
    try {
      const until = Date.now() + 8_000;
      for (;;) {
        const statuses = await Promise.all(runs.map(async (id) => (await t.repository.getRun(id))?.status));
        if (statuses.every((s) => s === 'succeeded')) break;
        if (Date.now() > until) throw new Error(`Runs did not finish: ${statuses.join(',')}`);
        await sleep(30);
      }
    } finally {
      await t.ctx.worker.stop(1000);
    }
    expect(most).toBe(2);
  });

  it('refuses a request body larger than it will read, with a fixed sentence and no detail', async () => {
    const t = await buildTestApp({ envVars: { MAX_BODY_BYTES: '2048' } });
    const big = await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/modify`, payload: { utterance: 'x'.repeat(3000) } });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toEqual({ error: { code: 'payload_too_large', message: 'That request is larger than this service accepts.' } });
    const small = await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/modify`, payload: { utterance: 'avoid overnight travel' } });
    expect(small.statusCode).toBe(200);
  });

  it('refuses a body that is huge and not JSON just as quickly', async () => {
    const t = await buildTestApp({ envVars: { MAX_BODY_BYTES: '2048' } });
    const res = await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/modify`, headers: { 'content-type': 'application/json' }, payload: 'A'.repeat(100_000) });
    expect(res.statusCode).toBe(413);
  });

  it('gives every search a deadline and a ceiling on provider requests, so a runaway search cannot spend without limit', async () => {
    let seen: { deadlineMs: number | null; max: number | undefined } = { deadlineMs: null, max: undefined };
    const services: PlanningServices = {
      buildPlans: async (deps) => {
        seen = { deadlineMs: deps.deadline ? deps.deadline.remainingMs() : null, max: deps.maxProviderRequests };
        return engineServices.buildPlans(deps);
      },
    };
    const travel = fakeTravelRegistry({});
    const t = await buildTestApp({ registry: travel.registry, planningServices: services, envVars: { MAX_PROVIDER_REQUESTS_PER_SEARCH: '77', PLANNING_TIMEOUT_MS: '40000', AGENT_TIMEOUT_MS: '5000' } });
    await answerRequired(t.app as never, TRIP_ID);
    await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` });
    await t.ctx.worker.drain();
    expect(seen.max).toBe(77);
    // What the providers may use is the search's time minus what the explanation is kept back.
    expect(seen.deadlineMs).not.toBeNull();
    expect(seen.deadlineMs!).toBeLessThan(40_000 - 5_000);
    expect(seen.deadlineMs!).toBeGreaterThan(20_000);
  });
});

describe('payload size', () => {
  it('says who you are and how many trips you have without reading a single trip: every page asks', async () => {
    const { app, repository } = await buildTestApp();
    repository.listSessions = async () => {
      throw new Error('the whole document of every trip was read just to count them');
    };
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json().tripCount).toBe(1);
  });
});

describe('a change that cannot start its search', () => {
  /** A trip with real plans on it, built by the real engine from in-memory providers. */
  async function plannedTrip(envVars: Record<string, string> = {}) {
    const travel = fakeTravelRegistry({});
    const t = await buildTestApp({ registry: travel.registry, envVars: { RATE_LIMIT_MAX: '1000', ...envVars } });
    await answerRequired(t.app as never, TRIP_ID);
    await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` });
    await t.ctx.worker.drain();
    const trip = (await t.repository.getSession(TRIP_ID))!;
    expect(trip.plans.length).toBeGreaterThan(0);
    return t;
  }

  it('turns the request away before saving anything when the queue is full', async () => {
    const t = await plannedTrip({ MAX_QUEUED_RUNS: '1' });
    const other = await personWithTrips(t, 1, 'x@example.com');
    await other.plan(other.trips[0]!.id); // fills the queue
    const before = (await t.repository.getSession(TRIP_ID))!;
    const res = await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/modify`, payload: { utterance: 'avoid overnight travel' } });
    expect(res.statusCode).toBe(503);
    const after = (await t.repository.getSession(TRIP_ID))!;
    expect(after.version).toBe(before.version); // nothing was written
    expect(after.plans).toHaveLength(before.plans.length);
    expect(after.stage).toBe(before.stage);
  });

  it('keeps the change and never leaves the trip "searching" with nothing searching, if the queue fills at the last moment', async () => {
    const t = await plannedTrip();
    // The queue check passes, then a competing request fills the last place before this one queues.
    t.ctx.runs.enqueue = async () => {
      throw ApiError.busy('A lot of people are planning trips right now.', 30);
    };
    const res = await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/modify`, payload: { utterance: 'avoid overnight travel' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('saved');
    expect(res.json().interpretation).toMatch(/could not be started right now/);
    const trip = (await t.repository.getSession(TRIP_ID))!;
    expect(trip.stage).not.toBe('searching');
    expect(trip.profile.transport.excludedModes).toBeDefined();
    expect(await t.repository.activeRunForTrip(TRIP_ID)).toBeNull();
  });
});

describe('the database misbehaving', () => {
  it('answers a read during an outage with a plain 500 that says nothing about the database', async () => {
    const t = await buildTestApp();
    t.repository.getSession = async () => {
      throw new Error('connect ECONNREFUSED 10.1.2.3:5432 password authentication failed for user "wayfare"');
    };
    const res = await t.app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}` });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'internal_error', message: 'Something went wrong on our side. Nothing was booked or charged.' } });
    expect(res.body).not.toMatch(/ECONNREFUSED|10\.1\.2\.3|wayfare|password|stack| at /);
  });

  it('reports itself degraded, without the reason, so a load balancer stops sending it work', async () => {
    const t = await buildTestApp();
    t.repository.healthCheck = async () => ({ ok: false, store: 'postgres', detail: 'unavailable', cause: 'FATAL: password authentication failed' });
    const res = await t.bare.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toMatch(/FATAL|password/);
  });

  it('marks a search failed, in words, when its plans cannot be saved, and keeps the detail in the log', async () => {
    const travel = fakeTravelRegistry({});
    const t = await buildTestApp({ registry: travel.registry });
    await answerRequired(t.app as never, TRIP_ID);
    const started = (await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` })).json().run as { id: string };
    const original = t.repository.updateSession.bind(t.repository);
    t.repository.updateSession = async () => {
      throw new Error('deadlock detected: relation "trips" 10.1.2.3');
    };
    await t.ctx.worker.drain();
    t.repository.updateSession = original;
    const run = (await t.app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}/runs/${started.id}` })).json().run;
    expect(run.status).toBe('failed');
    expect(run.error.message).toMatch(/Nothing was booked or charged/);
    expect(JSON.stringify(run)).not.toMatch(/deadlock|relation|10\.1\.2\.3/);
  });

  it('keeps a worker alive through a store outage, and picks work up when the store returns', async () => {
    const travel = fakeTravelRegistry({});
    const t = await buildTestApp({ registry: travel.registry, envVars: { RUN_POLL_MS: '50' } });
    await answerRequired(t.app as never, TRIP_ID);
    const started = (await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` })).json().run as { id: string };
    const realClaim = t.repository.claimRun.bind(t.repository);
    let outage = true;
    t.repository.claimRun = async (...args) => {
      if (outage) throw new Error('the database is restarting');
      return realClaim(...args);
    };
    t.ctx.worker.start();
    try {
      await sleep(200); // the worker is failing to poll, and must not have died
      outage = false;
      const until = Date.now() + 6_000;
      for (;;) {
        const status = (await t.repository.getRun(started.id))?.status;
        if (status === 'succeeded') break;
        if (Date.now() > until) throw new Error(`Still ${status}`);
        await sleep(30);
      }
    } finally {
      await t.ctx.worker.stop(1000);
    }
  });
});

describe('two changes at once never lose one silently', () => {
  it('leaves the trip with every change reported as applied, and none applied twice or dropped', async () => {
    const { app, repository } = await buildTestApp({ envVars: { RATE_LIMIT_MAX: '1000', RATE_LIMIT_ADDRESS_MAX: '1000' } });
    const before = (await repository.getSession(TRIP_ID))!.version;
    const styles = ['budget', 'standard', 'premium', 'luxury'];
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/answers`, payload: { key: 'style.travel_style', value: styles[i % styles.length] } }),
      ),
    );
    const applied = results.filter((r) => r.statusCode === 200).length;
    const conflicts = results.filter((r) => r.statusCode === 409);
    expect(applied + conflicts.length).toBe(24); // every request got a definite answer
    for (const c of conflicts) expect(c.json().error.code).toBe('trip_changed');
    // Each applied change is exactly one version. A silent overwrite would show as fewer versions than successes.
    expect((await repository.getSession(TRIP_ID))!.version).toBe(before + applied);
    expect(applied).toBeGreaterThan(0);
  });

  it('a save made against an old version is refused, not merged over the newer one', async () => {
    const { repository } = await buildTestApp();
    const stale = (await repository.getSession(TRIP_ID))!;
    await repository.updateSession({ ...stale, profile: { ...stale.profile, travelStyle: 'premium' } });
    await expect(repository.updateSession({ ...stale, profile: { ...stale.profile, travelStyle: 'budget' } })).rejects.toBeInstanceOf(TripChangedError);
    expect((await repository.getSession(TRIP_ID))!.profile.travelStyle).toBe('premium');
  });

  it('a deletion that fails is reported as failed, not as done', async () => {
    const { app, repository } = await buildTestApp();
    repository.deleteSession = async () => {
      throw new Error('connection reset');
    };
    const res = await app.inject({ method: 'DELETE', url: `/v1/trips/${TRIP_ID}` });
    expect(res.statusCode).toBe(500);
    expect(await repository.getSession(TRIP_ID)).not.toBeNull();
  });
});
