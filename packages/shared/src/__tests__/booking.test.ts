import { describe, expect, it } from 'vitest';
import {
  BOOKING_TRANSITIONS,
  CONFIRMED_STATES,
  nextBookingState,
  type BookingState,
} from '../booking.js';

describe('booking state machine', () => {
  it('walks the happy path only through declared transitions', () => {
    let state: BookingState = 'draft';
    const path = [
      'START_REVALIDATION',
      'REVALIDATION_OK',
      'SUBMIT_TRAVELER_DETAILS',
      'SUBMIT_REVIEW',
      'USER_CONFIRM',
    ] as const;

    for (const event of path) {
      const next = nextBookingState(state, event);
      expect(next, `${state} + ${event}`).not.toBeNull();
      state = next!;
    }
    expect(state).toBe('awaiting_confirmation');
  });

  it('forces a fresh re-price between confirmation and payment', () => {
    // A traveller may not be charged against a quote from twenty minutes ago,
    // so `awaiting_confirmation` has exactly one route onward, and it goes
    // through a re-price.
    expect(nextBookingState('awaiting_confirmation', 'PAYMENT_AUTHORIZED')).toBeNull();
    expect(nextBookingState('awaiting_confirmation', 'REVALIDATION_OK')).toBeNull();
    expect(nextBookingState('awaiting_confirmation', 'START_REVALIDATION')).toBe(
      'revalidating_for_payment',
    );
    expect(nextBookingState('revalidating_for_payment', 'REVALIDATION_OK')).toBe('payment_pending');
  });

  it('keeps the pre-payment re-price distinct from the ordinary one', () => {
    // Sharing one `revalidating` state would make the route onward depend on
    // where the booking came from, which the machine cannot know.
    expect(nextBookingState('revalidating', 'REVALIDATION_OK')).toBe('revalidated');
    expect(nextBookingState('revalidating_for_payment', 'REVALIDATION_OK')).not.toBe('revalidated');
  });

  it('sends a price change during the pre-payment re-price back for approval', () => {
    expect(nextBookingState('revalidating_for_payment', 'REVALIDATION_PRICE_CHANGED')).toBe(
      'price_changed',
    );
  });

  it('never reaches a confirmed state without the provider confirming', () => {
    for (const [state, transitions] of Object.entries(BOOKING_TRANSITIONS)) {
      for (const [event, target] of Object.entries(transitions)) {
        if (target && CONFIRMED_STATES.has(target as BookingState)) {
          expect(
            event.startsWith('PROVIDER_'),
            `${state} reaches ${target} via ${event}, which is not a provider response`,
          ).toBe(true);
        }
      }
    }
  });

  it('rejects events that are not valid from the current state', () => {
    expect(nextBookingState('draft', 'PROVIDER_CONFIRMED')).toBeNull();
    expect(nextBookingState('cancelled', 'USER_CONFIRM')).toBeNull();
    expect(nextBookingState('refunded', 'START_REVALIDATION')).toBeNull();
  });

  it('routes a cancellation of a live booking through a refund, not straight to cancelled', () => {
    expect(nextBookingState('ticketed', 'CANCEL')).toBe('refund_pending');
    expect(nextBookingState('refund_pending', 'REFUND_COMPLETED')).toBe('refunded');
  });
});
