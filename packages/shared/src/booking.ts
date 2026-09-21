import { z } from 'zod';
import { Money } from './money.js';

/**
 * Booking state machine. The only states that assert a reservation exists are
 * `confirmed` and `ticketed`, and both are reachable only from a provider
 * response carrying a provider reference. Nothing in the codebase may set them
 * optimistically.
 */
export const BookingState = z.enum([
  'draft',
  'revalidating',
  /** The mandatory re-price between the traveller's go-ahead and payment.
   *  It is a separate state from `revalidating` because the two return to
   *  different places, and a single shared state would make the route to
   *  payment ambiguous — which is how a stale price reaches a card. */
  'revalidating_for_payment',
  'revalidated',
  'price_changed',
  'unavailable',
  'traveler_details_pending',
  'review_pending',
  'awaiting_confirmation',
  'payment_pending',
  'payment_authorized',
  'provider_booking',
  'confirmed',
  'ticketed',
  'failed',
  'cancelled',
  'refund_pending',
  'refunded',
]);
export type BookingState = z.infer<typeof BookingState>;

export const BookingEvent = z.enum([
  'START_REVALIDATION',
  'REVALIDATION_OK',
  'REVALIDATION_PRICE_CHANGED',
  'REVALIDATION_UNAVAILABLE',
  'ACCEPT_NEW_PRICE',
  'SUBMIT_TRAVELER_DETAILS',
  'SUBMIT_REVIEW',
  'USER_CONFIRM',
  'PAYMENT_AUTHORIZED',
  'PAYMENT_FAILED',
  'PROVIDER_BOOKING_STARTED',
  'PROVIDER_CONFIRMED',
  'PROVIDER_TICKETED',
  'PROVIDER_FAILED',
  'CANCEL',
  'REFUND_INITIATED',
  'REFUND_COMPLETED',
]);
export type BookingEvent = z.infer<typeof BookingEvent>;

export const BOOKING_TRANSITIONS: Record<BookingState, Partial<Record<BookingEvent, BookingState>>> =
  {
    draft: { START_REVALIDATION: 'revalidating', CANCEL: 'cancelled' },
    revalidating: {
      REVALIDATION_OK: 'revalidated',
      REVALIDATION_PRICE_CHANGED: 'price_changed',
      REVALIDATION_UNAVAILABLE: 'unavailable',
      CANCEL: 'cancelled',
    },
    revalidated: { SUBMIT_TRAVELER_DETAILS: 'traveler_details_pending', CANCEL: 'cancelled' },
    price_changed: {
      ACCEPT_NEW_PRICE: 'revalidated',
      START_REVALIDATION: 'revalidating',
      CANCEL: 'cancelled',
    },
    unavailable: { CANCEL: 'cancelled', START_REVALIDATION: 'revalidating' },
    traveler_details_pending: { SUBMIT_REVIEW: 'review_pending', CANCEL: 'cancelled' },
    review_pending: { USER_CONFIRM: 'awaiting_confirmation', CANCEL: 'cancelled' },
    // Re-validation is mandatory immediately before charging: a price quoted
    // minutes ago is not a price the traveller may be billed for. The only
    // exit toward payment is through `revalidating_for_payment`.
    awaiting_confirmation: {
      START_REVALIDATION: 'revalidating_for_payment',
      CANCEL: 'cancelled',
    },
    revalidating_for_payment: {
      REVALIDATION_OK: 'payment_pending',
      REVALIDATION_PRICE_CHANGED: 'price_changed',
      REVALIDATION_UNAVAILABLE: 'unavailable',
      CANCEL: 'cancelled',
    },
    payment_pending: { PAYMENT_AUTHORIZED: 'payment_authorized', PAYMENT_FAILED: 'failed', CANCEL: 'cancelled' },
    payment_authorized: { PROVIDER_BOOKING_STARTED: 'provider_booking' },
    provider_booking: { PROVIDER_CONFIRMED: 'confirmed', PROVIDER_FAILED: 'failed' },
    confirmed: { PROVIDER_TICKETED: 'ticketed', CANCEL: 'refund_pending' },
    ticketed: { CANCEL: 'refund_pending' },
    failed: { REFUND_INITIATED: 'refund_pending', CANCEL: 'cancelled' },
    cancelled: {},
    refund_pending: { REFUND_COMPLETED: 'refunded' },
    refunded: {},
  };

export function nextBookingState(state: BookingState, event: BookingEvent): BookingState | null {
  return BOOKING_TRANSITIONS[state][event] ?? null;
}

/** States in which the system may tell the traveller a reservation exists. */
export const CONFIRMED_STATES: ReadonlySet<BookingState> = new Set(['confirmed', 'ticketed']);

export const TravelerDetails = z.object({
  /** Index in the party; used to map to per-passenger provider records. */
  index: z.number().int().min(0),
  type: z.enum(['adult', 'child', 'infant']),
  title: z.string().nullable().default(null),
  givenName: z.string().min(1),
  familyName: z.string().min(1),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gender: z.enum(['male', 'female', 'unspecified']).nullable().default(null),
  email: z.string().email().nullable().default(null),
  phone: z.string().nullable().default(null),
  nationality: z.string().length(2).nullable().default(null),
  /** Travel document. Stored encrypted at rest; never written to logs. */
  document: z
    .object({
      type: z.enum(['passport', 'national_id']),
      number: z.string(),
      issuingCountry: z.string().length(2),
      expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .nullable()
    .default(null),
  assistanceRequests: z.array(z.string()).default([]),
});
export type TravelerDetails = z.infer<typeof TravelerDetails>;

export const BookingRecord = z.object({
  id: z.string(),
  tripId: z.string(),
  state: BookingState,
  /** Which component of the trip this booking covers. */
  component: z.enum(['transport_outbound', 'transport_return', 'hotel', 'transfer', 'activity']),
  provider: z.string(),
  /** Set only by a provider response. Its presence is what proves the booking. */
  providerReference: z.string().nullable().default(null),
  quotedPrice: Money,
  confirmedPrice: Money.nullable().default(null),
  /** Client-supplied key that makes retries safe against double booking. */
  idempotencyKey: z.string(),
  history: z
    .array(
      z.object({
        at: z.string().datetime(),
        from: BookingState,
        event: BookingEvent,
        to: BookingState,
        note: z.string().nullable().default(null),
      }),
    )
    .default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type BookingRecord = z.infer<typeof BookingRecord>;
