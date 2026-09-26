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
