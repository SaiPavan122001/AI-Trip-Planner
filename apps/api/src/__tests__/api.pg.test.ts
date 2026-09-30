import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import type { PrismaClient } from '@prisma/client';
import { TripLlm } from '@trip/llm';
import type { AppContext } from '../context.js';
import { PrismaRepository } from '../repository/prisma.js';
import { buildServer } from '../server.js';
import { RunWorker } from '../worker/run-worker.js';
import { SECRET_TOKEN, fakeTravelRegistry } from './fake-providers.js';
import { testEnv } from './helpers.js';
import { answerRequired, cookieFrom, newTripBody } from './test-kit.js';

/**
 * The whole path over HTTP against a real PostgreSQL: an anonymous visitor
 * plans a trip, a worker searches in the background, and what comes back
 * survives being stored as JSONB (which does not keep key order, and so would
 * break a run's fingerprint if it were computed carelessly).
 */

let app: FastifyInstance;
let ctx: AppContext;
let store: PrismaRepository;
let prisma: PrismaClient;

beforeAll(async () => {
  store = PrismaRepository.fromUrl(inject('databaseUrl'));
  prisma = (store as unknown as { prisma: PrismaClient }).prisma;
  ({ app, ctx } = await buildServer({
    env: testEnv({ RUN_LEASE_MS: '1000', RUN_POLL_MS: '50' }),
    logger: pino({ level: 'silent' }),
    registry: fakeTravelRegistry().registry,
    llm: new TripLlm(null),
    repository: store,
  }));
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "audit_events","planning_runs","traveler_records","bookings","trips","auth_sessions","login_challenges","idempotency_keys","users" CASCADE',
  );
});

/** A new visitor's first trip, as their browser would make it. */
async function visitorWithTrip() {
  const created = await app.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody });
  expect(created.statusCode).toBe(201);
  const cookie = `tp_session=${cookieFrom(created)!}`;
  const id = created.json().trip.id as string;
  const as = (opts: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; payload?: object }) =>
    app.inject({ ...opts, headers: { cookie } });
  return { id, cookie, as };
}

describe('planning against PostgreSQL', () => {
  it('plans a trip end to end, in the background', async () => {
    const { id, as } = await visitorWithTrip();
    await answerRequired({ inject: (o: never) => as(o) } as never, id);

    const started = await as({ method: 'POST', url: `/v1/trips/${id}/plan` });
    expect(started.statusCode).toBe(202);
    const runId = started.json().run.id as string;

    expect(await ctx.worker.drain()).toBe(1);

    const run = (await as({ method: 'GET', url: `/v1/trips/${id}/runs/${runId}` })).json().run;
    expect(run).toMatchObject({ status: 'succeeded', error: null });
    const trip = await as({ method: 'GET', url: `/v1/trips/${id}` });
    expect(trip.json().trip.plans.length).toBeGreaterThan(0);
    expect(trip.json().trip.version).toBeGreaterThan(1);
    expect(trip.body).not.toContain(SECRET_TOKEN);
  });

  it('keeps the tokens the browser must not see in the database, for later use', async () => {
    const { id, as } = await visitorWithTrip();
    await answerRequired({ inject: (o: never) => as(o) } as never, id);
    await as({ method: 'POST', url: `/v1/trips/${id}/plan` });
    await ctx.worker.drain();

    const stored = await store.getSession(id);
    expect(JSON.stringify(stored)).toContain(SECRET_TOKEN);
  });

  it('runs a search once when several workers are looking for work', async () => {
    const { id, as } = await visitorWithTrip();
    await answerRequired({ inject: (o: never) => as(o) } as never, id);
    await as({ method: 'POST', url: `/v1/trips/${id}/plan` });

    const workers = [1, 2, 3].map(() => new RunWorker({ store, runs: ctx.runs, env: ctx.env, logger: ctx.logger }));
    const done = await Promise.all(workers.map((w) => w.drain()));

    expect(done.reduce((a, b) => a + b, 0)).toBe(1);
    const run = await store.latestRunForTrip(id);
    expect(run).toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it('recovers a search whose worker died', async () => {
    const { id, as } = await visitorWithTrip();
    await answerRequired({ inject: (o: never) => as(o) } as never, id);
    const started = (await as({ method: 'POST', url: `/v1/trips/${id}/plan` })).json().run as { id: string };

    await store.claimRun('dead-worker', 40, 3);
    await new Promise((r) => setTimeout(r, 150));
    expect(await ctx.worker.drain()).toBe(1);

    expect(await store.getRun(started.id)).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('discards a search when the trip changed while it waited', async () => {
    const { id, as } = await visitorWithTrip();
    await answerRequired({ inject: (o: never) => as(o) } as never, id);
    const started = (await as({ method: 'POST', url: `/v1/trips/${id}/plan` })).json().run as { id: string };
    await as({ method: 'POST', url: `/v1/trips/${id}/answers`, payload: { key: 'style.travel_style', value: 'premium' } });

    await ctx.worker.drain();

    expect((await store.getRun(started.id))?.status).toBe('superseded');
    expect((await store.getSession(id))?.plans).toEqual([]);
  });

  it('lets only one search be active per trip, even when asked at the same instant', async () => {
    const { id, as } = await visitorWithTrip();
    await answerRequired({ inject: (o: never) => as(o) } as never, id);
    const results = await Promise.all(Array.from({ length: 4 }, () => as({ method: 'POST', url: `/v1/trips/${id}/plan` })));

    expect(results.every((r) => r.statusCode === 202)).toBe(true);
    expect(new Set(results.map((r) => r.json().run.id)).size).toBe(1);
    const active = await prisma.planningRun.count({ where: { tripId: id, status: { in: ['queued', 'running'] } } });
    expect(active).toBe(1);
  });

  it('applies simultaneous answers without losing either', async () => {
    const { id, as } = await visitorWithTrip();
    const [a, b] = await Promise.all([
      as({ method: 'POST', url: `/v1/trips/${id}/answers`, payload: { key: 'style.travel_style', value: 'premium' } }),
      as({ method: 'POST', url: `/v1/trips/${id}/answers`, payload: { key: 'accommodation.rooms', value: 1 } }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const stored = await store.getSession(id);
    expect(stored?.profile.travelStyle).toBe('premium');
    expect(stored?.profile.accommodation.rooms).toBe(1);
  });

  it('keeps one person’s trips from another, and removes everything when an account is deleted', async () => {
    const mine = await visitorWithTrip();
    const theirs = await visitorWithTrip();
    expect((await theirs.as({ method: 'GET', url: `/v1/trips/${mine.id}` })).statusCode).toBe(404);

    const deleted = await mine.as({ method: 'DELETE', url: '/v1/me', payload: { confirm: 'delete my account' } });
    expect(deleted.statusCode).toBe(204);
    expect(await store.getSession(mine.id)).toBeNull();
    expect(await store.getSession(theirs.id)).not.toBeNull();
    expect(await prisma.user.count()).toBe(1);
  });
});
