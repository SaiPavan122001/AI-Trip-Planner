import { describe, expect, it } from 'vitest';
import { TripChangedError } from '../repository/types.js';
import { TRIP_ID, buildTestApp } from './helpers.js';

/**
 * Two things happening to one trip at once must not lose either of them, and
 * must never silently overwrite one with the other.
 */

const answer = (app: { inject: (o: never) => Promise<{ statusCode: number }> }, key: string, value: unknown) =>
  app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/answers`, payload: { key, value } } as never);

describe('simultaneous changes to one trip', () => {
  it('applies two answers sent at the same moment, both of them', async () => {
    const { app, repository } = await buildTestApp();
    const results = await Promise.all([
      answer(app, 'style.travel_style', 'premium'),
      answer(app, 'accommodation.rooms', 1),
    ]);

    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    const stored = await repository.getSession(TRIP_ID);
    expect(stored?.profile.travelStyle).toBe('premium');
    expect(stored?.profile.accommodation.rooms).toBe(1);
    expect(stored?.version).toBe(2);
  });

  it('reports a lost race as a conflict, with a code a client can act on, when it cannot be redone', async () => {
    const { app, repository } = await buildTestApp();
    // Every save finds that someone else got there first.
    repository.updateSession = async () => {
      throw new TripChangedError();
    };

    const res = await app.inject({
      method: 'POST',
      url: `/v1/trips/${TRIP_ID}/answers`,
      payload: { key: 'style.travel_style', value: 'premium' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('trip_changed');
    expect((await repository.getSession(TRIP_ID))?.profile.travelStyle).toBeNull();
  });
});
