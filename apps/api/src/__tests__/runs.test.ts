import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { InMemoryRepository } from '../repository/memory.js';
import { TRIP_ID, buildTestApp, sessionFixture } from './helpers.js';
import { SECRET_TOKEN, fakeTravelRegistry, type FlightSearchStub } from './fake-providers.js';
import { newTripBody } from './test-kit.js';

/**
 * Planning happens in the background: the request returns at once with a run,
 * a worker searches, and the trip carries the plans when it is done.
 */

const plan = (app: FastifyInstance) => app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` });
const trip = (app: FastifyInstance) => app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}` });
const run = (app: FastifyInstance, runId: string) =>
  app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}/runs/${runId}` });
const cancel = (app: FastifyInstance, runId: string) =>
  app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/runs/${runId}/cancel` });

/** Another tab changes an answer: the trip's inputs are no longer the ones a queued search was made for. */
async function changeTrip(repository: InMemoryRepository): Promise<void> {
  const current = (await repository.getSession(TRIP_ID))!;
  await repository.updateSession({ ...current, profile: { ...current.profile, travelStyle: 'premium' } });
}

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 6000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > until) throw new Error(`Timed out waiting; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const withTravel = (envVars: Record<string, string> = {}, flights?: FlightSearchStub) => {
  const travel = fakeTravelRegistry(flights ? { flights } : {});
  return buildTestApp({ registry: travel.registry, envVars }).then((t) => ({ ...t, travel }));
};

describe('starting a search', () => {
  it('returns at once with a queued run, and does not search in the request', async () => {
    const { app, travel } = await withTravel();
    const res = await plan(app);

    expect(res.statusCode).toBe(202);
    expect(res.json().run).toMatchObject({ status: 'queued', kind: 'plan', tripId: TRIP_ID });
    expect(res.json().reused).toBe(false);
    expect(travel.calls).toEqual({ flights: 0, hotels: 0 });
    // The trip shows it, so a screen that was closed and reopened can pick it up.
    expect((await trip(app)).json().run).toMatchObject({ status: 'queued' });
  });

  it('builds plans in the background and puts them on the trip', async () => {
    const { app, ctx } = await withTravel();
    const started = (await plan(app)).json().run as { id: string };

    await ctx.worker.drain();

    const finished = (await run(app, started.id)).json().run;
    expect(finished).toMatchObject({ status: 'succeeded', error: null });
    expect(finished.progress).toEqual({ step: 'done', label: 'Done', percent: 100 });
    const saved = (await trip(app)).json().trip;
    expect(saved.plans.length).toBeGreaterThan(0);
    expect(saved.selectedPlanId).toBe(saved.plans[0].id);
    expect(saved.stage).toBe('planned');
    expect(saved.lastSearch.hotelsConsidered).toBe(2);
    expect(saved.lastSearch.outbound.modes.some((m: { mode: string }) => m.mode === 'flight')).toBe(true);
  });

  it('runs itself in an in-process worker without waiting for a poll', async () => {
    const { app, ctx } = await withTravel({ RUN_POLL_MS: '60000' });
    ctx.worker.start();
    try {
      const started = (await plan(app)).json().run as { id: string };
      const finished = await waitFor(
        async () => (await run(app, started.id)).json().run as { status: string },
        (r) => r.status === 'succeeded',
        4000,
      );
      expect(finished.status).toBe('succeeded');
    } finally {
      await ctx.worker.stop(1000);
    }
  });

  it('gives the same run to a second request for the same search', async () => {
    const { app } = await withTravel();
    const first = (await plan(app)).json();
    const second = await plan(app);
    expect(second.statusCode).toBe(202);
    expect(second.json().run.id).toBe(first.run.id);
    expect(second.json().reused).toBe(true);
  });

  it('refuses a different search while one is running, and says which', async () => {
    const { app, repository } = await withTravel();
    const first = (await plan(app)).json().run as { id: string };
    await changeTrip(repository);

    const second = await plan(app);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatchObject({ code: 'run_in_progress', details: { run: { id: first.id } } });
  });

  it('will not change the trip while it is being searched', async () => {
    const { app } = await withTravel();
    await plan(app);
    const res = await app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/modify`, payload: { utterance: 'make it cheaper' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('run_in_progress');
  });

  it('requires the required answers first', async () => {
    const { app, ctx } = await buildTestApp({ geocoding: true, seedTrip: false });
    void ctx;
    const created = await app.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody });
    const res = await app.inject({ method: 'POST', url: `/v1/trips/${created.json().trip.id}/plan` });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details).toHaveProperty('nextQuestion');
  });
});

describe('what a search may and may not leave behind', () => {
  it('throws away plans made for a trip that has since changed', async () => {
    const { app, ctx, repository } = await withTravel();
    const started = (await plan(app)).json().run as { id: string };
    // The traveller changes an answer before a worker gets to the search.
    await changeTrip(repository);

    await ctx.worker.drain();

    expect((await run(app, started.id)).json().run.status).toBe('superseded');
    const saved = await repository.getSession(TRIP_ID);
    expect(saved?.plans).toEqual([]);
    expect(saved?.lastSearch).toBeNull();
    // And the traveller is free to search again for the trip as it now is.
    expect((await plan(app)).statusCode).toBe(202);
  });

  it('never sends a provider’s revalidation token to the browser', async () => {
    const { app, ctx } = await withTravel();
    await plan(app);
    await ctx.worker.drain();

    const body = (await trip(app)).body;
    expect(body).toContain('"plans"');
    expect(body).not.toContain(SECRET_TOKEN);
    expect((await app.inject({ method: 'GET', url: '/v1/trips' })).body).not.toContain(SECRET_TOKEN);
    expect((await app.inject({ method: 'GET', url: '/v1/me/export' })).body).toContain(SECRET_TOKEN);
  });
});

describe('stopping a search', () => {
  it('cancels one that has not started', async () => {
    const { app, ctx } = await withTravel();
    const started = (await plan(app)).json().run as { id: string };

    const res = await cancel(app, started.id);
    expect(res.statusCode).toBe(202);
    expect(res.json().run.status).toBe('cancelled');
    expect(await ctx.worker.drain()).toBe(0);
    expect((await plan(app)).statusCode).toBe(202);
  });

  it('cancels one in progress, cutting the provider call short', async () => {
    let seen: AbortSignal | undefined;
    let entered!: () => void;
    const inProvider = new Promise<void>((resolve) => (entered = resolve));
    const { app, ctx, repository } = await withTravel({ RUN_LEASE_MS: '1000', RUN_POLL_MS: '50' }, async (req) => {
      seen = req.signal;
      entered();
      await new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(req.signal?.reason)));
      return undefined;
    });
    ctx.worker.start();
    try {
      const started = (await plan(app)).json().run as { id: string };
      await inProvider;

      const asked = await cancel(app, started.id);
      expect(asked.json().run).toMatchObject({ status: 'running', cancelRequested: true });

      const done = await waitFor(
        async () => (await run(app, started.id)).json().run as { status: string },
        (r) => r.status !== 'running',
      );
      expect(done.status).toBe('cancelled');
      expect(seen?.aborted).toBe(true);
      expect((await repository.getSession(TRIP_ID))?.plans).toEqual([]);
    } finally {
      await ctx.worker.stop(1000);
    }
  });

  it('cancelling a finished search just returns it', async () => {
    const { app, ctx } = await withTravel();
    const started = (await plan(app)).json().run as { id: string };
    await ctx.worker.drain();
    expect((await cancel(app, started.id)).json().run.status).toBe('succeeded');
  });
});

describe('when a search goes wrong', () => {
  it('a provider that hangs costs its own results, not the search: the run finishes and the trip says that source timed out', async () => {
    const { app, ctx } = await withTravel({ PLANNING_TIMEOUT_MS: '2500', AGENT_TIMEOUT_MS: '1000' }, async (req) => {
      await new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(req.signal?.reason)));
      return undefined;
    });
    const started = (await plan(app)).json().run as { id: string };
    const began = Date.now();
    await ctx.worker.drain();

    const finished = (await run(app, started.id)).json().run;
    expect(finished.status).toBe('succeeded');
    // Cut off by its stage's share of the time, well inside the search's own limit.
    expect(Date.now() - began).toBeLessThan(2500);
    const saved = (await trip(app)).json().trip;
    expect(saved.providerNotes).toEqual(
      expect.arrayContaining([expect.objectContaining({ capability: 'flights', status: 'timeout' })]),
    );
  });

  it('still fails a search whose own work will not finish, and says so in words', async () => {
    const hangs = { buildPlans: (deps: { signal?: AbortSignal }) => new Promise<never>((_, reject) => deps.signal?.addEventListener('abort', () => reject(deps.signal?.reason))) };
    const travel = fakeTravelRegistry({});
    const { app, ctx } = await buildTestApp({ registry: travel.registry, envVars: { PLANNING_TIMEOUT_MS: '150' }, planningServices: hangs as never });
    const started = (await plan(app)).json().run as { id: string };
    await ctx.worker.drain();

    const failed = (await run(app, started.id)).json().run;
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ code: 'planning_timeout' });
    expect(failed.error.message).toMatch(/too long/);
  });

  it('carries on when one provider crashes: the search succeeds and says that source failed', async () => {
    const { app, ctx } = await withTravel({}, async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432 secret-internal-detail');
    });
    const started = (await plan(app)).json().run as { id: string };
    await ctx.worker.drain();

    const finished = await run(app, started.id);
    expect(finished.json().run).toMatchObject({ status: 'succeeded' });
    const saved = (await trip(app)).json().trip;
    // The journey could not be searched, so the plans have the stay and the trip says why there is no flight.
    expect(saved.providerNotes).toEqual(
      expect.arrayContaining([expect.objectContaining({ capability: 'flights', status: 'unavailable' })]),
    );
    expect(JSON.stringify(saved)).not.toMatch(/ECONNREFUSED|secret-internal-detail|10.0.0.5/);
    expect(saved.lastSearch.feasibility.findings.map((f: { code: string }) => f.code)).toContain('outward_providers_failed');
  });

  it('fails a crash in the search itself with a plain message and keeps the detail out of the response', async () => {
    const { app, ctx, repository } = await withTravel();
    const original = repository.updateSession.bind(repository);
    let crashed = false;
    repository.updateSession = async (session) => {
      // Saving the plans is what the run does last; a database fault there is not a provider's.
      if (!crashed && session.plans.length > 0) {
        crashed = true;
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432 secret-internal-detail');
      }
      return original(session);
    };
    const started = (await plan(app)).json().run as { id: string };
    await ctx.worker.drain();

    const failed = await run(app, started.id);
    expect(failed.json().run).toMatchObject({ status: 'failed', error: { code: 'planning_failed' } });
    expect(failed.body).not.toMatch(/ECONNREFUSED|secret-internal-detail|10.0.0.5/);
    expect(failed.json().run.error.message).toMatch(/Nothing was booked/);
    // The trip is still there and can be searched again.
    expect((await plan(app)).statusCode).toBe(202);
  });

  it('picks up a run whose worker died, and counts the attempt', async () => {
    const { app, ctx, repository } = await withTravel({ RUN_LEASE_MS: '1000' });
    const started = (await plan(app)).json().run as { id: string };
    // A worker takes it, and dies without a word.
    await repository.claimRun('dead-worker', 30, 3);
    await new Promise((r) => setTimeout(r, 100));

    expect(await ctx.worker.drain()).toBe(1);
    const finished = await repository.getRun(started.id);
    expect(finished).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('gives up on a run that keeps killing its workers', async () => {
    const { app, ctx, repository } = await withTravel({ RUN_MAX_ATTEMPTS: '2' });
    const started = (await plan(app)).json().run as { id: string };
    for (let i = 0; i < 2; i += 1) {
      await repository.claimRun('dead-worker', 20, 2);
      await new Promise((r) => setTimeout(r, 60));
    }

    expect(await ctx.worker.drain()).toBe(0);
    const failed = (await run(app, started.id)).json().run;
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'interrupted' } });
  });
});

describe('limits', () => {
  it('limits how many searches someone may start in a day', async () => {
    const { app, ctx } = await withTravel({ PLAN_RUNS_PER_DAY_ANONYMOUS: '1' });
    expect((await plan(app)).statusCode).toBe(202);
    await ctx.worker.drain();

    const second = await plan(app);
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toMatchObject({ code: 'daily_search_limit', details: { limit: 1 } });
  });

  it('counts each person separately', async () => {
    const { app, ctx, repository, asStranger } = await withTravel({ PLAN_RUNS_PER_DAY_ANONYMOUS: '1' });
    await plan(app);
    await ctx.worker.drain();
    expect((await plan(app)).statusCode).toBe(429);

    const { app: other, user } = await asStranger();
    const theirs = '44444444-4444-4444-8444-444444444444';
    await repository.createSession(sessionFixture(theirs, user.id));
    const res = await other.inject({ method: 'POST', url: `/v1/trips/${theirs}/plan` });
    expect(res.statusCode).toBe(202);
  });
});
