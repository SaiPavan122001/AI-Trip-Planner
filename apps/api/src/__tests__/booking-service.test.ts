import { beforeEach, describe, expect, it } from 'vitest';
import { ProviderRegistry, loadProvidersEnv } from '@trip/providers';
import {
  BOOKING_TRANSITIONS,
  BookingEvent,
  BookingState,
  CLIENT_BOOKING_EVENTS,
  type BookingRecord,
} from '@trip/shared';
import { InMemoryRepository } from '../repository/memory.js';
import { BookingService } from '../services/booking-service.js';
import { ApiError } from '../errors.js';
import { sessionFixture } from './helpers.js';

/**
 * The booking state machine's security invariant, tested against the service
 * rather than HTTP because booking is switched off in this release. It must
 * hold on the day booking is switched back on.
 *
 * The invariant: a client can never produce a fact that only a provider or a
 * payment processor can know. The test that used to live here drove a
 * booking to `confirmed` by posting `PROVIDER_CONFIRMED` with a reference the
 * client invented; that is exactly what must be impossible.
 */

/** States that assert something a third party did. */
const THIRD_PARTY_STATES: ReadonlySet<BookingState> = new Set<BookingState>([
  'payment_pending',
  'payment_authorized',
  'provider_booking',
  'confirmed',
  'ticketed',
  'refunded',
]);

const SERVER_ONLY_EVENTS = BookingEvent.options.filter((e) => !CLIENT_BOOKING_EVENTS.has(e));

let repository: InMemoryRepository;
let service: BookingService;
let booking: BookingRecord;

beforeEach(async () => {
  repository = new InMemoryRepository();
  const session = sessionFixture();
  await repository.createSession(session);
  service = new BookingService({
    registry: new ProviderRegistry(loadProvidersEnv({})),
    repository,
  });
  booking = await service.create(
    {
      tripId: session.id,
      component: 'transport_outbound',
      offerId: 'test-offer',
      provider: 'amadeus',
      quotedPrice: { amount: 960000, currency: 'INR' },
      idempotencyKey: 'test-create-0001',
      principal: null,
    },
    session,
  );
});

describe('client-originated booking events', () => {
  it('lists only events a traveller can genuinely originate', () => {
    expect([...CLIENT_BOOKING_EVENTS].sort()).toEqual(
      ['ACCEPT_NEW_PRICE', 'CANCEL', 'SUBMIT_REVIEW', 'SUBMIT_TRAVELER_DETAILS', 'USER_CONFIRM'].sort(),
    );
  });

  it.each(SERVER_ONLY_EVENTS)('refuses %s from a client, leaving the booking untouched', async (event) => {
    const before = await service.get(booking.id);

    const attempt = service.applyClientEvent(booking.id, event);
    await expect(attempt).rejects.toBeInstanceOf(ApiError);
    await expect(attempt).rejects.toMatchObject({ statusCode: 403, code: 'event_not_permitted' });

    const after = await service.get(booking.id);
    expect(after.state).toBe(before.state);
    expect(after.history).toEqual(before.history);
    expect(after.providerReference).toBeNull();
  });

  it('never lets client events reach a payment or provider state, from any state', () => {
    // Exhaustive over the declared machine: if someone later adds a client
    // transition into a third-party state, this fails.
    for (const state of BookingState.options) {
      for (const event of CLIENT_BOOKING_EVENTS) {
        const next = BOOKING_TRANSITIONS[state][event];
        if (next === undefined) continue;
        expect(
          THIRD_PARTY_STATES.has(next),
          `${state} --${event}--> ${next} lets a client assert a third-party fact`,
        ).toBe(false);
      }
    }
  });

  it('ignores a provider reference smuggled into a client event', async () => {
    const cancelled = await service.applyClientEvent(booking.id, 'CANCEL', {
      note: 'changed my mind',
      providerReference: 'PNR123',
    } as { note: string });

    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.providerReference).toBeNull();
  });

  it('still rejects a client event that is not valid from the current state', async () => {
    await expect(service.applyClientEvent(booking.id, 'USER_CONFIRM')).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe('server-side re-pricing', () => {
  it('records "unavailable" rather than "revalidated" when no provider can re-price', async () => {
    const result = await service.revalidate(booking.id, 'token');

    // With no flight provider connected there is nothing that could confirm
    // the price, so the only honest outcome is unavailable.
    expect(result.booking.state).toBe('unavailable');
    expect(result.booking.confirmedPrice).toBeNull();
  });
});

describe('re-pricing names the provider offer, never an internal id', () => {
  const hotelOffer = (refundable = true) => ({
    id: 'amadeus-hotel:TESTHTL1',
    name: 'Test Hotel',
    propertyType: null,
    category: 4,
    guestRating: null,
    guestRatingCount: null,
    coordinates: { lat: 12.97, lon: 77.59 },
    address: null,
    neighbourhood: null,
    amenities: [],
    checkInTime: null,
    checkOutTime: null,
    images: [],
    rooms: [
      {
        id: 'OFFER-ABC-1', description: 'Room', roomType: null, beds: null, maxOccupancy: null, boardType: null,
        breakfastIncluded: null, refundable, cancellationDeadline: null, cancellationPolicy: null,
        totalPrice: { amount: 960000, currency: 'INR' }, pricePerNight: { amount: 240000, currency: 'INR' },
        taxesIncluded: null, revalidationToken: 'OFFER-ABC-1',
      },
    ],
    provenance: {
      provider: 'amadeus', providerLabel: 'Amadeus', retrievedAt: '2026-01-01T00:00:00.000Z',
      validUntil: null, searchId: null, attribution: null,
    },
  });

  function serviceWithHotelProvider() {
    const received: unknown[][] = [];
    const registry = {
      flights: [],
      hotels: [
        {
          descriptor: { id: 'amadeus' },
          revalidateHotel: async (...args: unknown[]) => {
            received.push(args);
            return { status: 'ok', data: hotelOffer(), provenance: hotelOffer().provenance, warnings: [] };
          },
        },
      ],
    } as unknown as ProviderRegistry;
    return { service: new BookingService({ registry, repository }), received };
  }

  it('passes the provider’s own token to a hotel provider, and nothing else', async () => {
    const { service: svc, received } = serviceWithHotelProvider();
    const hotelBooking = await svc.create(
      {
        tripId: booking.tripId,
        component: 'hotel',
        offerId: 'amadeus-hotel:TESTHTL1',
        provider: 'amadeus',
        quotedPrice: { amount: 960000, currency: 'INR' },
        idempotencyKey: 'test-hotel-0001',
        principal: null,
      },
      sessionFixture(),
    );

    const result = await svc.revalidate(hotelBooking.id, 'OFFER-ABC-1');

    // Exactly one argument: the provider's token. Not the booking's UUID.
    expect(received).toEqual([['OFFER-ABC-1']]);
    expect(received.flat()).not.toContain(hotelBooking.id);
    expect(result.booking.state).toBe('revalidated');
  });
});
