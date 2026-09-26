import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { InMemoryRepository } from '../repository/memory.js';
import { BOOKING_UNAVAILABLE_MESSAGE } from '../routes/bookings.js';
import { TRIP_ID, buildTestApp } from './helpers.js';

/**
 * Booking is not part of this release. These tests pin that down at the HTTP
 * boundary: every booking route answers with an explained refusal, and none
 * of them stores anything, including traveller identity documents.
 *
 * The state machine's own guarantees (clients cannot manufacture payment or
 * provider events) are tested against the service in booking-service.test.ts,
 * so they hold when booking is enabled in a later phase.
 */

const BOOKING_ID = '22222222-2222-4222-8222-222222222222';

const ROUTES: Array<{ method: 'GET' | 'POST'; url: string; payload?: unknown }> = [
  {
    method: 'POST',
    url: `/v1/trips/${TRIP_ID}/bookings`,
    payload: {
      component: 'transport_outbound',
      offerId: 'test-offer',
      provider: 'amadeus',
      quotedPrice: { amount: 960000, currency: 'INR' },
    },
  },
  { method: 'GET', url: `/v1/trips/${TRIP_ID}/bookings` },
  { method: 'GET', url: `/v1/bookings/${BOOKING_ID}` },
  { method: 'POST', url: `/v1/bookings/${BOOKING_ID}/revalidate`, payload: { revalidationToken: 'x' } },
  // The exact request that used to walk a booking to "confirmed" with a
  // reference the client made up.
  {
    method: 'POST',
    url: `/v1/bookings/${BOOKING_ID}/events`,
    payload: { event: 'PROVIDER_CONFIRMED', providerReference: 'PNR123' },
  },
  { method: 'POST', url: `/v1/bookings/${BOOKING_ID}/events`, payload: { event: 'PAYMENT_AUTHORIZED' } },
  { method: 'POST', url: `/v1/bookings/${BOOKING_ID}/confirm` },
];

let app: FastifyInstance;
let repository: InMemoryRepository;

beforeEach(async () => {
  ({ app, repository } = await buildTestApp());
});

describe('booking is not available in this release', () => {
  it.each(ROUTES)('$method $url refuses with an explanation', async (route) => {
    const res = await app.inject({
      method: route.method,
      url: route.url,
      headers: { 'idempotency-key': 'test-key-00000001' },
      ...(route.payload === undefined ? {} : { payload: route.payload as object }),
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({
      error: { code: 'booking_unavailable', message: BOOKING_UNAVAILABLE_MESSAGE },
    });
    // No route may leave a booking behind, whatever it was asked to do.
    expect(await repository.listBookingsForTrip(TRIP_ID)).toEqual([]);
  });

  it('does not store traveller identity documents', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/trips/${TRIP_ID}/travelers`,
      payload: [
        {
          index: 0,
          type: 'adult',
          givenName: 'Test',
          familyName: 'Traveller',
          dateOfBirth: '1990-01-01',
          document: {
            type: 'passport',
            number: 'TEST0000',
            issuingCountry: 'IN',
            expiryDate: '2031-01-01',
          },
        },
      ],
    });

    expect(res.statusCode).toBe(501);
    expect(res.body).not.toContain('TEST0000');
    expect(await repository.getTravelerDetails(TRIP_ID)).toEqual([]);
  });

  it('says nothing was booked or charged', async () => {
    const res = await app.inject({ method: 'POST', url: `/v1/bookings/${BOOKING_ID}/confirm` });
    expect(res.json().error.message).toMatch(/Nothing has been booked or charged/);
  });
});
