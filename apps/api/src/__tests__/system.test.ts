import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Store } from '../repository/store.js';
import { TRIP_ID, buildTestApp } from './helpers.js';

let app: FastifyInstance;

beforeEach(async () => {
  ({ app } = await buildTestApp());
});

describe('system endpoints', () => {
  it('says which providers are missing and what each one needs', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/providers' });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.configured).toEqual([]);
    expect(body.disabled.map((d: { id: string }) => d.id)).toContain('amadeus');
    expect(body.disabled.find((d: { id: string }) => d.id === 'amadeus').requiredEnv).toContain(
      'AMADEUS_CLIENT_ID',
    );
    expect(body.dataPolicy).toMatch(/rather than substituting an estimate/i);
  });

  it('is not ready without a geocoder, because nothing can be classified', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });

    expect(res.statusCode).toBe(503);
    expect(res.json().geocoding).toBe('not configured');
  });

  it('accepts a command with no body', async () => {
    // Browsers send Content-Type: application/json even with an empty body.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/trips/${TRIP_ID}/plan`,
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).not.toBe(400);
  });
});

describe('health endpoints', () => {
  it('never returns the underlying database error to the public', async () => {
    const { repository } = await buildTestApp();
    const failing: Store = Object.create(repository, {
      healthCheck: {
        value: async () => ({
          ok: false,
          store: 'postgresql',
          detail: 'The database could not be reached.',
          cause: 'connect ECONNREFUSED db.internal.example:5432 (user wayfare)',
        }),
      },
    });
    const { app: failingApp } = await buildTestApp({ repository: failing });

    for (const url of ['/health', '/ready']) {
      const res = await failingApp.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toMatch(/ECONNREFUSED|db.internal|wayfare/);
    }
    expect((await failingApp.inject({ method: 'GET', url: '/health' })).json().store.detail).toBe(
      'The database could not be reached.',
    );
  });
});
