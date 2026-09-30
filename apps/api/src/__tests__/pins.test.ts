import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { TripPlan } from '@trip/shared';
import { TRIP_ID, buildTestApp } from './helpers.js';
import { fakeTravelRegistry } from './fake-providers.js';
import { answerRequired, modelSaying } from './test-kit.js';

/**
 * Pins: parts of a plan the traveller asked to keep. They persist, they
 * survive a re-plan exactly as they were, and when a change makes one
 * impossible to keep the traveller is told which and why.
 */

const url = (path: string) => `/v1/trips/${TRIP_ID}${path}`;

async function plannedTrip(options: Parameters<typeof buildTestApp>[0] = {}) {
  const travel = fakeTravelRegistry();
  const t = await buildTestApp({ registry: travel.registry, ...options });
  await answerRequired(t.app, TRIP_ID);
  await t.app.inject({ method: 'POST', url: url('/plan') });
  await t.ctx.worker.drain();
  return { ...t, travel };
}

const pin = (app: FastifyInstance, pins: string[]) => app.inject({ method: 'PUT', url: url('/pins'), payload: { pins } });
const tripPlans = async (app: FastifyInstance) =>
  ((await app.inject({ method: 'GET', url: url('') })).json().trip.plans ?? []) as TripPlan[];

describe('pinning parts of the plan', () => {
  it('remembers what was pinned', async () => {
    const { app } = await plannedTrip();
    const res = await pin(app, ['hotel', 'outbound']);

    expect(res.statusCode).toBe(200);
    expect(res.json().trip.pins.sort()).toEqual(['hotel', 'outbound']);
    expect(res.json().refused).toEqual([]);
    expect((await app.inject({ method: 'GET', url: url('') })).json().trip.pins.sort()).toEqual(['hotel', 'outbound']);
  });

  it('replaces the whole set, so unpinning is just leaving one out', async () => {
    const { app } = await plannedTrip();
    await pin(app, ['hotel', 'outbound']);
    expect((await pin(app, ['outbound'])).json().trip.pins).toEqual(['outbound']);
    expect((await pin(app, [])).json().trip.pins).toEqual([]);
  });

  it('says why something cannot be pinned, instead of quietly ignoring it', async () => {
    const { app } = await plannedTrip();
    const res = await pin(app, ['transfers', 'activities', 'hotel']);

    expect(res.json().trip.pins).toEqual(['hotel']);
    const reasons = Object.fromEntries(res.json().refused.map((r: { component: string; reason: string }) => [r.component, r.reason]));
    expect(reasons['transfers']).toMatch(/recalculated/);
    expect(reasons['activities']).toMatch(/nothing of that kind/);
  });

  it('cannot pin anything before there is a plan', async () => {
    const { app } = await buildTestApp();
    const res = await pin(app, ['hotel']);
    expect(res.json().trip.pins).toEqual([]);
    expect(res.json().refused).toHaveLength(1);
  });

  it('rejects a part that does not exist', async () => {
    const { app } = await plannedTrip();
    expect((await pin(app, ['spaceship'])).statusCode).toBe(400);
  });
});

describe('pins through a re-plan', () => {
  it('keeps a pinned hotel exactly, and searches everything else again', async () => {
    const { app, ctx, travel } = await plannedTrip();
    const before = (await tripPlans(app))[0]!;
    const pinnedHotel = before.hotels[0]!.hotel.id;
    await pin(app, ['hotel']);
    const hotelSearches = travel.calls.hotels;
    const flightSearches = travel.calls.flights;

    const started = await app.inject({ method: 'POST', url: url('/plan') });
    expect(started.json()).toMatchObject({ pinsReleased: [] });
    await ctx.worker.drain();

    const plans = await tripPlans(app);
    expect(plans.length).toBeGreaterThan(0);
    for (const p of plans) expect(p.hotels[0]!.hotel.id).toBe(pinnedHotel);
    // The hotel was not searched for again, the flights were.
    expect(travel.calls.hotels).toBe(hotelSearches);
    expect(travel.calls.flights).toBeGreaterThan(flightSearches);
  });

  it('keeps a pinned hotel when the traveller asks for more comfort', async () => {
    const { app, ctx } = await plannedTrip();
    const pinnedHotel = (await tripPlans(app))[0]!.hotels[0]!.hotel.id;
    await pin(app, ['hotel']);

    const res = await app.inject({ method: 'POST', url: url('/modify'), payload: { utterance: 'make it more comfortable' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'replanning', run: { status: 'queued', kind: 'replan' } });
    expect(res.json().kept).toContain('hotel');
    expect(res.json().released).toEqual([]);
    await ctx.worker.drain();
    for (const p of await tripPlans(app)) expect(p.hotels[0]!.hotel.id).toBe(pinnedHotel);
  });

  it('tells the traveller when new dates mean a pinned hotel cannot be kept, and drops the pin', async () => {
    const llm = modelSaying({ intent: 'change_dates', parameters: { departureDate: '2030-12-01' }, pinnedComponents: [] });
    const { app, ctx, repository } = await plannedTrip({ llm });
    await pin(app, ['hotel']);

    const asked = (await app.inject({ method: 'POST', url: url('/modify'), payload: { utterance: 'move it to 1 December' } })).json();
    expect(asked.status).toBe('needs_consent');
    // The traveller is told before they answer.
    expect(asked.consent.question).toMatch(/hotel you asked to keep will be replaced/);

    const done = (
      await app.inject({
        method: 'POST',
        url: url('/modify/consent'),
        payload: { pendingModificationId: asked.consent.id, accept: true },
      })
    ).json();

    expect(done.status).toBe('replanning');
    expect(done.released).toEqual([{ component: 'hotel', reason: 'The hotel cannot be kept: it was for the old dates.' }]);
    expect(done.kept).not.toContain('hotel');
    expect(done.trip.pins).toEqual([]);
    // The old plans were for the old dates, so they are not left looking current.
    expect(done.trip.plans).toEqual([]);
    expect(done.trip.intent.departureDate).toBe('2030-12-01');

    await ctx.worker.drain();
    const stored = await repository.getSession(TRIP_ID);
    expect(stored?.plans.length).toBeGreaterThan(0);
    expect(stored?.plans[0]!.hotels[0]!.checkIn).toBe('2030-12-01');
    expect(stored?.decisionLog.some((e) => e.step === 'pins' && /Released hotel/.test(e.detail))).toBe(true);
  });

  it('releases a pin that no longer fits when a search is started, and reports it', async () => {
    const { app, ctx, repository } = await plannedTrip();
    await pin(app, ['hotel', 'outbound']);
    // The dates moved some other way (another tab); the plan on file is for the old ones.
    const current = (await repository.getSession(TRIP_ID))!;
    await repository.updateSession({
      ...current,
      intent: { ...current.intent, departureDate: '2030-12-01', returnDate: '2030-12-05' },
    });

    const res = await app.inject({ method: 'POST', url: url('/plan') });

    expect(res.statusCode).toBe(202);
    const released = res.json().pinsReleased as Array<{ component: string; reason: string }>;
    expect(released.map((r) => r.component).sort()).toEqual(['hotel', 'outbound']);
    for (const r of released) expect(r.reason).toMatch(/old dates/);
    expect(res.json().trip.pins).toEqual([]);

    await ctx.worker.drain();
    const plans = await tripPlans(app);
    expect(plans[0]!.hotels[0]!.checkIn).toBe('2030-12-01');
  });

  it('keeps a pin across an unrelated answer', async () => {
    const { app } = await plannedTrip();
    await pin(app, ['hotel']);
    await app.inject({ method: 'POST', url: url('/answers'), payload: { key: 'style.travel_style', value: 'premium' } });
    expect((await app.inject({ method: 'GET', url: url('') })).json().trip.pins).toEqual(['hotel']);
  });
});
