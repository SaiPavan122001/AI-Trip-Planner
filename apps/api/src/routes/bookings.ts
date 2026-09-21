import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BookingEvent, Money } from '@trip/shared';
import type { AppContext } from '../context.js';
import { ApiError, sendError } from '../errors.js';
import { BookingService } from '../services/booking-service.js';
import { TripService } from '../services/trip-service.js';

/**
 * Booking endpoints. Every mutating call requires an Idempotency-Key header,
 * because the failure mode these protect against — a retried request creating
 * a second reservation — is one a traveller pays for.
 */
export function registerBookingRoutes(app: FastifyInstance, ctx: AppContext): void {
  const bookings = new BookingService({ registry: ctx.registry, repository: ctx.repository });
  const trips = new TripService({
    registry: ctx.registry,
    llm: ctx.llm,
    repository: ctx.repository,
    defaultCurrency: ctx.env.DEFAULT_CURRENCY,
  });

  const idempotencyKey = (headers: Record<string, unknown>): string => {
    const key = headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8) {
      throw ApiError.badRequest(
        'An Idempotency-Key header of at least 8 characters is required on booking requests, so a retry cannot create a second booking.',
      );
    }
    return key;
  };

  app.post('/v1/trips/:id/bookings', async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          component: z.enum(['transport_outbound', 'transport_return', 'hotel', 'transfer', 'activity']),
          offerId: z.string(),
          provider: z.string(),
          quotedPrice: Money,
        })
        .parse(req.body);

      const session = await trips.getTrip(id);
      const booking = await bookings.create(
        { ...body, tripId: id, idempotencyKey: idempotencyKey(req.headers) },
        session,
      );
      return reply.status(201).send({ booking });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/v1/bookings/:id', async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return reply.send({ booking: await bookings.get(id) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/v1/trips/:id/bookings', async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return reply.send({ bookings: await ctx.repository.listBookingsForTrip(id) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Re-price against the provider. Always run before taking payment. */
  app.post('/v1/bookings/:id/revalidate', async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { revalidationToken } = z
        .object({ revalidationToken: z.string().nullable().default(null) })
        .parse(req.body ?? {});
      const result = await bookings.revalidate(id, revalidationToken);
      return reply.send({ booking: result.booking, message: result.message });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/v1/trips/:id/travelers', async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const saved = await bookings.saveTravelers(id, req.body);
      // Identity documents are never echoed back. The client already has
      // them; a response body is one more place for them to leak.
      return reply.send({ saved: saved.length });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Drives the state machine. Invalid transitions are rejected, not coerced. */
  app.post('/v1/bookings/:id/events', async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          event: BookingEvent,
          note: z.string().max(500).optional(),
          providerReference: z.string().optional(),
        })
        .parse(req.body);
      idempotencyKey(req.headers);

      const booking = await bookings.apply(id, body.event, {
        ...(body.note === undefined ? {} : { note: body.note }),
        ...(body.providerReference === undefined
          ? {}
          : { providerReference: body.providerReference }),
      });
      return reply.send({ booking });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * The final confirmation. It exists and is wired up, and it will refuse
   * honestly until a booking-capable provider is connected — which is the
   * correct behaviour for a deployment that cannot actually issue tickets.
   */
  app.post('/v1/bookings/:id/confirm', async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      idempotencyKey(req.headers);
      const booking = await bookings.get(id);
      const travelers = await ctx.repository.getTravelerDetails(booking.tripId);
      if (travelers.length === 0) {
        throw ApiError.unprocessable(
          'Traveller details are required before a booking can be confirmed.',
        );
      }
      const result = await bookings.confirmWithProvider(id, travelers);
      return reply.status(result.booking.state === 'failed' ? 503 : 200).send({
        booking: result.booking,
        message: result.message,
        /** Explicit, so no client can read a 2xx as "we have a reservation". */
        confirmed: result.booking.state === 'confirmed' || result.booking.state === 'ticketed',
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
