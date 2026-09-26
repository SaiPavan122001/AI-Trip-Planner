import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PlanningSession } from '@trip/shared';
import { InMemoryRepository } from '../repository/memory.js';
import { TRIP_ID, buildTestApp, sessionFixture } from './helpers.js';

/**
 * Answers arrive in an HTTP body and are untrusted. A rejected answer must
 * leave the stored trip exactly as it was, and still readable: the failure
 * this guards against is a single bad value making a trip permanently
 * unloadable once it has been written to PostgreSQL.
 */

let app: FastifyInstance;
let repository: InMemoryRepository;

beforeEach(async () => {
  ({ app, repository } = await buildTestApp());
});

const answer = (payload: unknown) =>
  app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/answers`, payload: payload as object });

describe('POST /v1/trips/:id/answers', () => {
  it.each([
    ['an option that does not exist', { key: 'style.travel_style', value: 'foo' }],
    ['a list with an unknown option', { key: 'priorities.ranking', value: ['cheapest', 'bribery'] }],
    ['a fractional number', { key: 'transport.baggage', value: 1.5 }],
    ['more rooms than people', { key: 'accommodation.rooms', value: 9 }],
    ['money in another currency', { key: 'budget.total', value: { amount: 100000, currency: 'USD' } }],
    ['a negative budget', { key: 'budget.total', value: { amount: -5, currency: 'INR' } }],
    ['text that is far too long', { key: 'accommodation.location', value: 'x'.repeat(5000) }],
    ['a skip of a required question', { key: 'budget.total', value: null, skipped: true }],
  ])('rejects %s and leaves the trip unchanged', async (_label, body) => {
    const before = await repository.getSession(TRIP_ID);

    const res = await answer(body);

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
    // The offending question is named, so the client can highlight it.
    expect(res.json().error.details).toEqual({ key: body.key });

    const after = await repository.getSession(TRIP_ID);
    expect(after).toEqual(before);

    // And the trip still loads over HTTP: nothing was poisoned.
    const reload = await app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}` });
    expect(reload.statusCode).toBe(200);
  });

  it('stores a valid answer and moves the interview on', async () => {
    const res = await answer({ key: 'style.travel_style', value: 'premium' });

    expect(res.statusCode).toBe(200);
    expect(res.json().trip.profile.travelStyle).toBe('premium');
    expect(res.json().trip.profile.answeredKeys).toContain('style.travel_style');
  });

  it('records a valid budget as the traveller\'s guide', async () => {
    const res = await answer({ key: 'budget.total', value: { amount: 15_000_000, currency: 'INR' } });

    expect(res.statusCode).toBe(200);
    expect(res.json().trip.constraints.budget.total).toEqual({ amount: 15_000_000, currency: 'INR' });
  });

  it('never echoes a rejected value back', async () => {
    const res = await answer({ key: 'style.travel_style', value: '<script>alert(1)</script>' });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('<script>');
  });
});

describe('the store refuses documents it could not read back', () => {
  it('rejects an invalid session on update and keeps the previous version', async () => {
    const poisoned = sessionFixture();
    (poisoned.profile as { travelStyle: unknown }).travelStyle = 'foo';

    await expect(repository.updateSession(poisoned as PlanningSession)).rejects.toThrow(
      /does not match the session schema at profile\.travelStyle/,
    );

    const stored = await repository.getSession(TRIP_ID);
    expect(stored?.profile.travelStyle).toBeNull();
  });

  it('rejects an invalid session on create', async () => {
    const poisoned = sessionFixture('33333333-3333-4333-8333-333333333333');
    (poisoned.profile.transport as { latestArrivalLocal: unknown }).latestArrivalLocal = '9pm';

    await expect(repository.createSession(poisoned)).rejects.toThrow(/latestArrivalLocal/);
    expect(await repository.getSession(poisoned.id)).toBeNull();
  });

  it('is not affected by a caller mutating an object after saving it', async () => {
    const session = await repository.getSession(TRIP_ID);
    (session!.profile as { travelStyle: unknown }).travelStyle = 'foo';

    const stored = await repository.getSession(TRIP_ID);
    expect(stored?.profile.travelStyle).toBeNull();
  });
});

describe('a firm budget', () => {
  const total = { key: 'budget.total', value: { amount: 15_000_000, currency: 'INR' } };

  it('is a guide by default: the total is recorded but does not filter or block', async () => {
    const res = await answer(total);
    const budget = res.json().trip.constraints;
    expect(budget.budget.firm).toBe(false);
    expect(budget.hard.map((h: { kind: string }) => h.kind)).not.toContain('max_total_budget');
    expect(budget.budget.total).toEqual({ amount: 15_000_000, currency: 'INR' });
  });

  it('becomes a hard limit when the traveller says so', async () => {
    await answer(total);
    const res = await answer({ key: 'budget.firm', value: 'firm' });
    const constraints = res.json().trip.constraints;
    expect(constraints.budget.firm).toBe(true);
    expect(constraints.hard).toContainEqual({ kind: 'max_total_budget', value: { amount: 15_000_000, currency: 'INR' } });
  });

  it('goes back to a guide when the answer is withdrawn', async () => {
    await answer(total);
    await answer({ key: 'budget.firm', value: 'firm' });
    const res = await answer({ key: 'budget.firm', value: null, skipped: true });
    expect(res.json().trip.constraints.budget.firm).toBe(false);
  });

  it('keeps the firm flag when the total is answered again', async () => {
    await answer(total);
    await answer({ key: 'budget.firm', value: 'firm' });
    const res = await answer({ key: 'budget.total', value: { amount: 9_000_000, currency: 'INR' } });
    expect(res.json().trip.constraints.budget.firm).toBe(true);
    expect(res.json().trip.constraints.budget.total.amount).toBe(9_000_000);
  });
});
