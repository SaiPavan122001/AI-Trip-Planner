import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { ProviderRegistry, loadProvidersEnv } from '@trip/providers';
import { TripLlm } from '@trip/llm';
import type { PlanningSession } from '@trip/shared';
import { buildServer } from '../server.js';
import { InMemoryRepository } from '../repository/memory.js';
import { loadEnv } from '../env.js';

/**
 * HTTP-level tests for the booking endpoints. These exist because the rules
 * they cover are the ones that cost a traveller money when they break:
 * idempotency, and the refusal to claim a reservation exists.
 */

const session = (id: string): PlanningSession =>
  ({
    id,
    ownerId: null,
    stage: 'planned',
    intent: {
      originQuery: 'Hyderabad',
      destinationQuery: 'Bengaluru',
      departureDate: '2030-11-10',
      returnDate: '2030-11-14',
      travelers: { adults: 2, children: 0, infants: 0 },
      currency: 'INR',
      origin: {
        id: 'p1',
        name: 'Hyderabad',
        displayName: 'Hyderabad, India',
        coordinates: { lat: 17.385, lon: 78.4867 },
        countryCode: 'IN',
        countryName: 'India',
        timezone: 'Asia/Kolkata',
        airports: [],
        source: 'test',
        resolvedAt: '2026-01-01T00:00:00.000Z',
      },
      destination: {
        id: 'p2',
        name: 'Bengaluru',
        displayName: 'Bengaluru, India',
        coordinates: { lat: 12.9716, lon: 77.5946 },
        countryCode: 'IN',
        countryName: 'India',
        timezone: 'Asia/Kolkata',
        airports: [],
        source: 'test',
        resolvedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    classification: {
      scope: 'domestic',
      originCountry: 'IN',
      destinationCountry: 'IN',
      greatCircleKm: 497,
      crossesTimezones: false,
      originTimezone: 'Asia/Kolkata',
      destinationTimezone: 'Asia/Kolkata',
      surfaceRoutePlausible: true,
      eligibleModes: ['flight', 'train'],
      excludedModes: [],
      documentationNotes: [],
    },
    profile: {
      partyType: null,
      purpose: null,
      travelStyle: null,
      priorities: [],
      accommodation: {
        types: ['hotel'],
        minCategory: null,
        roomType: null,
        rooms: 1,
        bedsPerRoom: null,
        breakfastIncluded: null,
        privateBathroom: null,
        locationPreference: null,
        maxDistanceToActivitiesKm: null,
        freeCancellationRequired: false,
        amenities: [],
      },
      transport: {
        cabinClass: null,
        preferredCarriers: [],
        avoidedCarriers: [],
        maxStops: null,
        avoidOvernightTravel: false,
        avoidRedEyeArrival: false,
        earliestDepartureLocal: null,
        latestArrivalLocal: null,
        checkedBagsPerTraveler: 0,
        cabinBagsPerTraveler: 1,
        excludedModes: [],
        refundableRequired: false,
      },
      special: {
        accessibility: [],
        dietary: [],
        travelingWithInfant: false,
        travelingWithElderly: false,
        assistanceNotes: [],
        petsTraveling: false,
      },
      answeredKeys: [],
      skippedKeys: [],
    },
    constraints: {
      hard: [],
      soft: [],
      budget: {
        total: null,
        transport: null,
        accommodation: null,
        dailySpend: null,
        activities: null,
      },
      waivers: [],
    },
    questionnaire: null,
    plans: [],
    selectedPlanId: null,
    providerNotes: [],
    decisionLog: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }) as PlanningSession;

const TRIP_ID = '11111111-1111-4111-8111-111111111111';

let app: FastifyInstance;
let repository: InMemoryRepository;

beforeEach(async () => {
  repository = new InMemoryRepository();
  await repository.createSession(session(TRIP_ID));

  ({ app } = await buildServer({
    env: loadEnv({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    logger: pino({ level: 'silent' }),
    // An empty environment: no providers configured, which is also the
    // honest default a fresh clone runs in.
    registry: new ProviderRegistry(loadProvidersEnv({})),
    llm: new TripLlm(null),
    repository,
  }));
});

/** Sends one event with a unique idempotency key. */
const event = (bookingId: string, name: string, key: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/bookings/${bookingId}/events`,
    headers: { 'idempotency-key': key },
    payload: { event: name },
  });

/** Walks a booking through a sequence of events. */
async function walk(bookingId: string, events: string[], prefix = 'walk'): Promise<void> {
  for (const [i, name] of events.entries()) {
    await event(bookingId, name, `${prefix}-${bookingId.slice(0, 4)}-${i}`);
  }
}

const create = (key: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/trips/${TRIP_ID}/bookings`,
    headers: { 'idempotency-key': key },
    payload: {
      component: 'transport_outbound',
      offerId: 'test-offer',
      provider: 'amadeus',
      quotedPrice: { amount: 960000, currency: 'INR' },
    },
  });

describe('booking endpoints', () => {
  it('requires an idempotency key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/trips/${TRIP_ID}/bookings`,
      payload: {
        component: 'hotel',
        offerId: 'x',
        provider: 'amadeus',
        quotedPrice: { amount: 1, currency: 'INR' },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/Idempotency-Key/);
  });

  it('creates a booking in draft, with no provider reference', async () => {
    const res = await create('key-create-0001');

    expect(res.statusCode).toBe(201);
    expect(res.json().booking.state).toBe('draft');
    expect(res.json().booking.providerReference).toBeNull();
  });

  it('returns the original booking when a request is retried', async () => {
    const first = await create('key-retry-0001');
    const second = await create('key-retry-0001');

    expect(second.statusCode).toBe(201);
    // The same key must never produce a second reservation.
    expect(second.json().booking.id).toBe(first.json().booking.id);
    expect(await repository.listBookingsForTrip(TRIP_ID)).toHaveLength(1);
  });

  it('rejects an event that is not valid from the current state', async () => {
    const { booking } = (await create('key-invalid-0001')).json();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${booking.id}/events`,
      headers: { 'idempotency-key': 'key-invalid-0002' },
      payload: { event: 'USER_CONFIRM' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/state "draft"/);
  });

  it('will not jump straight to confirmed from the traveller’s go-ahead', async () => {
    const { booking } = (await create('key-shortcut-001')).json();
    await walk(booking.id, [
      'START_REVALIDATION',
      'REVALIDATION_OK',
      'SUBMIT_TRAVELER_DETAILS',
      'SUBMIT_REVIEW',
      'USER_CONFIRM',
    ]);

    const res = await event(booking.id, 'PROVIDER_CONFIRMED', 'key-shortcut-002');

    // Confirming the traveller's intent is not the same as the provider
    // confirming a reservation, and the machine keeps them apart.
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/state "awaiting_confirmation"/);
  });

  it('forces a fresh re-price between the go-ahead and taking payment', async () => {
    const { booking } = (await create('key-reprice-001')).json();
    await walk(booking.id, [
      'START_REVALIDATION',
      'REVALIDATION_OK',
      'SUBMIT_TRAVELER_DETAILS',
      'SUBMIT_REVIEW',
      'USER_CONFIRM',
    ]);

    // A price quoted twenty minutes ago is not a price anyone may be charged.
    const straightToPayment = await event(booking.id, 'PAYMENT_AUTHORIZED', 'key-reprice-002');
    expect(straightToPayment.statusCode).toBe(409);

    await walk(booking.id, ['START_REVALIDATION', 'REVALIDATION_OK'], 'key-reprice-ok');
    const authorised = await event(booking.id, 'PAYMENT_AUTHORIZED', 'key-reprice-003');
    expect(authorised.json().booking.state).toBe('payment_authorized');
  });

  it('refuses to mark a booking confirmed without a provider reference', async () => {
    const { booking } = (await create('key-confirm-0001')).json();
    await walk(booking.id, [
      'START_REVALIDATION',
      'REVALIDATION_OK',
      'SUBMIT_TRAVELER_DETAILS',
      'SUBMIT_REVIEW',
      'USER_CONFIRM',
      'START_REVALIDATION',
      'REVALIDATION_OK',
      'PAYMENT_AUTHORIZED',
      'PROVIDER_BOOKING_STARTED',
    ]);

    const withoutReference = await event(booking.id, 'PROVIDER_CONFIRMED', 'key-confirm-0002');
    expect(withoutReference.statusCode).toBe(409);
    expect(withoutReference.json().error.message).toMatch(/reference from the provider/i);

    // With a reference, the same event is allowed: the reference is the proof.
    const withReference = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${booking.id}/events`,
      headers: { 'idempotency-key': 'key-confirm-0003' },
      payload: { event: 'PROVIDER_CONFIRMED', providerReference: 'PNR123' },
    });
    expect(withReference.json().booking.state).toBe('confirmed');
    expect(withReference.json().booking.providerReference).toBe('PNR123');
  });

  it('will not confirm before traveller details exist', async () => {
    const { booking } = (await create('key-details-0001')).json();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${booking.id}/confirm`,
      headers: { 'idempotency-key': 'key-details-0002' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/Traveller details are required/i);
  });

  it('does not echo traveller identity documents back', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/trips/${TRIP_ID}/travelers`,
      payload: [
        {
          index: 0,
          type: 'adult',
          givenName: 'A',
          familyName: 'B',
          dateOfBirth: '1990-01-01',
          document: {
            type: 'passport',
            number: 'X1234567',
            issuingCountry: 'IN',
            expiryDate: '2031-01-01',
          },
        },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ saved: 1 });
    expect(res.body).not.toContain('X1234567');
  });

  it('reports an unknown booking as not found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/bookings/22222222-2222-4222-8222-222222222222',
    });

    expect(res.statusCode).toBe(404);
  });
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
