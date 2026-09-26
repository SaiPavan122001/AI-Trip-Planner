import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
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
