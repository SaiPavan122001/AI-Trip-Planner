import { randomUUID } from 'node:crypto';
import type { ProviderRegistry } from '@trip/providers';
import {
  BookingEvent,
  CONFIRMED_STATES,
  isClientBookingEvent,
  TravelerDetails,
  compare,
  formatMoney,
  isOk,
  nextBookingState,
  type BookingRecord,
  type Money,
  type PlanningSession,
} from '@trip/shared';
import { ApiError } from '../errors.js';
import type { TripRepository } from '../repository/types.js';

/**
 * Booking.
 *
 * Three rules are enforced here and nowhere else:
 *
 *  1. A state is only ever reached through a declared transition. There is no
 *     code path that assigns `confirmed` directly.
 *  2. `confirmed` and `ticketed` require a provider reference. Without one,
 *     the booking failed, whatever else happened.
 *  3. The price is re-validated with the provider immediately before payment.
 *     A quote from twenty minutes ago is not a price anyone may be charged.
 *
 * Card data never enters this service. Payment authorisation is expected to
 * happen client-side against a PSP, and only the resulting authorisation
 * reference is accepted here.
 */

export interface BookingServiceDeps {
  registry: ProviderRegistry;
  repository: TripRepository;
}

export interface CreateBookingInput {
  tripId: string;
  component: BookingRecord['component'];
  offerId: string;
  provider: string;
  quotedPrice: Money;
  idempotencyKey: string;
}

export class BookingService {
  constructor(private readonly deps: BookingServiceDeps) {}

  async create(input: CreateBookingInput, session: PlanningSession): Promise<BookingRecord> {
    const claim = await this.deps.repository.claimIdempotencyKey(
      input.idempotencyKey,
      'booking.create',
    );
    if (claim.existing) return claim.existing as BookingRecord;

    const now = new Date().toISOString();
    const booking: BookingRecord = {
      id: randomUUID(),
      tripId: session.id,
      state: 'draft',
      component: input.component,
      provider: input.provider,
      providerReference: null,
      quotedPrice: input.quotedPrice,
      confirmedPrice: null,
      idempotencyKey: input.idempotencyKey,
      history: [],
      createdAt: now,
      updatedAt: now,
    };

    const created = await this.deps.repository.createBooking(booking);
    await this.deps.repository.completeIdempotencyKey(
      input.idempotencyKey,
      'booking.create',
      created,
    );
    return created;
  }

  async get(id: string): Promise<BookingRecord> {
    const booking = await this.deps.repository.getBooking(id);
    if (!booking) throw ApiError.notFound('That booking');
    return booking;
  }

  /**
   * The only way a client may move a booking. Events that record what a
   * provider or payment processor did are refused outright, whatever state
   * the booking is in: those facts can only come from this service's own
   * provider workflows, never from a request body.
   */
  async applyClientEvent(
    id: string,
    event: BookingEvent,
    detail: { note?: string } = {},
  ): Promise<BookingRecord> {
    if (!isClientBookingEvent(event)) {
      throw ApiError.forbidden(
        'event_not_permitted',
        `"${event}" records something a provider or payment processor did, so it can only be produced by the server.`,
      );
    }
    return this.transition(id, event, detail.note === undefined ? {} : { note: detail.note });
  }

  /**
   * Applies one event. An event that is not a declared transition from the
   * current state is rejected, which makes client bugs obvious instead of
   * silent. Private: server-side workflows call it with facts they obtained
   * from a provider; clients go through `applyClientEvent`.
   */
  private async transition(
    id: string,
    event: BookingEvent,
    detail: { note?: string; providerReference?: string; confirmedPrice?: Money } = {},
  ): Promise<BookingRecord> {
    const booking = await this.get(id);
    const next = nextBookingState(booking.state, event);
    if (!next) {
      throw ApiError.conflict(
        `A booking in state "${booking.state}" cannot handle "${event}".`,
      );
    }

    if (CONFIRMED_STATES.has(next) && !detail.providerReference && !booking.providerReference) {
      throw ApiError.conflict(
        'A booking cannot be marked confirmed without a reference from the provider. This is enforced so the system never tells a traveller they have a reservation that does not exist.',
      );
    }

    const updated: BookingRecord = {
      ...booking,
      state: next,
      providerReference: detail.providerReference ?? booking.providerReference,
      confirmedPrice: detail.confirmedPrice ?? booking.confirmedPrice,
      history: [
        ...booking.history,
        {
          at: new Date().toISOString(),
          from: booking.state,
          event,
          to: next,
          note: detail.note ?? null,
        },
      ],
      updatedAt: new Date().toISOString(),
    };

    return this.deps.repository.updateBooking(updated);
  }

  /**
   * Re-prices the booking against the provider. The three outcomes are all
   * real states: still available at the same price, still available at a
   * different price, or gone.
   */
  async revalidate(
    id: string,
    revalidationToken: string | null,
  ): Promise<{ booking: BookingRecord; message: string }> {
    let booking = await this.get(id);
    booking = await this.transition(id, 'START_REVALIDATION', { note: 'Re-pricing with the provider.' });

    if (booking.component === 'transport_outbound' || booking.component === 'transport_return') {
      const provider = this.deps.registry.flights.find(
        (p) => p.descriptor.id === booking.provider,
      );
      if (!provider || !revalidationToken) {
        const updated = await this.transition(id, 'REVALIDATION_UNAVAILABLE', {
          note: 'The provider that quoted this fare is no longer connected.',
        });
        return {
          booking: updated,
          message:
            'This fare cannot be re-priced because its provider is not connected. Search again to get a current price.',
        };
      }

      const res = await provider.revalidateFlight(revalidationToken);
      if (!isOk(res)) {
        const updated = await this.transition(id, 'REVALIDATION_UNAVAILABLE', { note: res.message });
        return { booking: updated, message: res.message };
      }

      const current = res.data.totalPrice;
      if (
        current.currency === booking.quotedPrice.currency &&
        compare(current, booking.quotedPrice) === 0
      ) {
        const updated = await this.transition(id, 'REVALIDATION_OK', {
          note: `Confirmed at ${formatMoney(current)}.`,
          confirmedPrice: current,
        });
        return { booking: updated, message: `Still available at ${formatMoney(current)}.` };
      }

      const updated = await this.transition(id, 'REVALIDATION_PRICE_CHANGED', {
        note: `Provider now quotes ${formatMoney(current)}, was ${formatMoney(booking.quotedPrice)}.`,
        confirmedPrice: current,
      });
      return {
        booking: updated,
        message: `The price changed from ${formatMoney(booking.quotedPrice)} to ${formatMoney(current)}. Nothing has been charged; confirm the new price to continue.`,
      };
    }

    if (booking.component === 'hotel') {
      const provider = this.deps.registry.hotels.find((p) => p.descriptor.id === booking.provider);
      if (!provider || !revalidationToken) {
        const updated = await this.transition(id, 'REVALIDATION_UNAVAILABLE', {
          note: 'The provider that quoted this rate is no longer connected.',
        });
        return { booking: updated, message: 'This rate cannot be re-priced.' };
      }
      const res = await provider.revalidateHotel(revalidationToken);
      if (!isOk(res)) {
        const updated = await this.transition(id, 'REVALIDATION_UNAVAILABLE', { note: res.message });
        return { booking: updated, message: res.message };
      }
      const room = res.data.rooms[0]!;
      const updated = await this.transition(
        id,
        compare(room.totalPrice, booking.quotedPrice) === 0
          ? 'REVALIDATION_OK'
          : 'REVALIDATION_PRICE_CHANGED',
        { confirmedPrice: room.totalPrice, note: `Provider quotes ${formatMoney(room.totalPrice)}.` },
      );
      return { booking: updated, message: `Provider quotes ${formatMoney(room.totalPrice)}.` };
    }

    const updated = await this.transition(id, 'REVALIDATION_UNAVAILABLE', {
      note: 'No provider supports re-pricing this component.',
    });
    return {
      booking: updated,
      message: 'This part of the trip cannot be booked through a connected provider.',
    };
  }

  async saveTravelers(tripId: string, raw: unknown): Promise<TravelerDetails[]> {
    const details = TravelerDetails.array().parse(raw);
    await this.deps.repository.saveTravelerDetails(tripId, details);
    return details;
  }

  /**
   * The final step. It refuses to run unless the booking has been re-priced
   * since the traveller confirmed, and it never invents a reference: the
   * provider's response is the only thing that can produce one.
   */
  async confirmWithProvider(
    id: string,
    _travelers: TravelerDetails[],
  ): Promise<{ booking: BookingRecord; message: string }> {
    const booking = await this.get(id);
    if (booking.state !== 'payment_authorized') {
      throw ApiError.conflict(
        `Booking is in state "${booking.state}". A provider booking is only attempted after payment has been authorised.`,
      );
    }

    await this.transition(id, 'PROVIDER_BOOKING_STARTED', { note: 'Sending the booking to the provider.' });

    // No connected adapter implements ticketing yet: Amadeus Self-Service
    // requires a separate production agreement for the Flight Create Orders
    // endpoint. Rather than simulate a confirmation, the booking fails with
    // an accurate reason and the payment is flagged for release.
    const failed = await this.transition(id, 'PROVIDER_FAILED', {
      note: 'No connected provider is authorised to issue tickets for this deployment.',
    });
    return {
      booking: failed,
      message:
        'This deployment has no provider authorised to issue tickets, so no booking was made and no charge should be captured. Connect a booking-capable provider to enable this step.',
    };
  }
}
