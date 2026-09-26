import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import type { ApiErrorBody } from '../errors.js';

/**
 * Booking is not part of this release.
 *
 * This deployment plans, compares and adjusts trips. It has no payment
 * provider and no provider authorised to issue tickets, so it cannot make a
 * reservation, and it must never look as though it can.
 *
 * Every booking route is still registered, so a client that calls one gets a
 * deliberate, explained answer rather than a generic "no route". None of them
 * read the request body, write anything, or contact a provider. In
 * particular, `POST /v1/trips/:id/travelers` does not store names, dates of
 * birth or passport numbers: there is nothing to use them for until booking
 * exists, and data that is never collected cannot leak.
 *
 * The booking state machine and `BookingService` are kept for the phase that
 * adds booking. They enforce that clients may only send client-originated
 * events (see `CLIENT_BOOKING_EVENTS` in @trip/shared), but they are not
 * reachable over HTTP from this release.
 */

export const BOOKING_UNAVAILABLE_MESSAGE =
  'Booking is not available yet. You can plan, compare and adjust trips here, and booking will be added in a later release. Nothing has been booked or charged.';

const BOOKING_ROUTES: Array<{ method: 'GET' | 'POST'; url: string }> = [
  { method: 'POST', url: '/v1/trips/:id/bookings' },
  { method: 'GET', url: '/v1/trips/:id/bookings' },
  { method: 'POST', url: '/v1/trips/:id/travelers' },
  { method: 'GET', url: '/v1/bookings/:id' },
  { method: 'POST', url: '/v1/bookings/:id/revalidate' },
  { method: 'POST', url: '/v1/bookings/:id/events' },
  { method: 'POST', url: '/v1/bookings/:id/confirm' },
];

function bookingUnavailable(reply: FastifyReply): FastifyReply {
  const body: ApiErrorBody = {
    error: { code: 'booking_unavailable', message: BOOKING_UNAVAILABLE_MESSAGE },
  };
  return reply.status(501).send(body);
}

export function registerBookingRoutes(app: FastifyInstance, _ctx: AppContext): void {
  for (const route of BOOKING_ROUTES) {
    app.route({
      method: route.method,
      url: route.url,
      handler: async (_req, reply) => bookingUnavailable(reply),
    });
  }
}
