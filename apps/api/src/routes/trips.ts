import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TripComponent } from '@trip/shared';
import { clearSessionCookie, startAnonymousSession } from '../auth/plugin.js';
import type { AuthService, Principal } from '../auth/service.js';
import type { AppContext } from '../context.js';
import { ApiError, sendError } from '../errors.js';
import { runView } from '../services/run-service.js';
import { TripService, type ModificationResult } from '../services/trip-service.js';
import { publicView } from '../util/public.js';

/**
 * Trip planning endpoints, in the order a traveller meets them:
 * create -> answer questions -> plan -> compare -> modify.
 *
 * Every trip belongs to the person who made it. A trip that is somebody
 * else's is reported exactly as one that does not exist.
 */
export function registerTripRoutes(app: FastifyInstance, ctx: AppContext, auth: AuthService): TripService {
  const service = new TripService({
    registry: ctx.registry,
    llm: ctx.llm,
    repository: ctx.repository,
    runs: ctx.runs,
  });

  /** Who is asking; refuses if nobody is signed in. Reading someone's trip needs a session. */
  const actor = (req: FastifyRequest): Principal => {
    if (!req.principal) throw ApiError.notFound('That trip');
    return req.principal;
  };

  const idParam = (req: FastifyRequest) => z.object({ id: z.string().uuid() }).parse(req.params).id;

  app.post(
    '/v1/trips',
    // Someone with no session is counted by address, which bounds how many
    // throwaway sessions (each with its own daily searches) one address can make.
    { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
    async (req, reply) => {
      try {
        // Anonymous planning is deliberately allowed: making someone sign up
        // before they can see whether a trip is even feasible is hostile. They
        // get a private session instead, and can sign in later to keep it.
        const returning = req.principal;
        const principal = returning ?? (await startAnonymousSession(req, reply, ctx, auth));
        try {
          const session = await service.createTrip(req.body, principal);
          return reply.status(201).send({ trip: publicView(session) });
        } catch (err) {
          // A visitor whose first request was refused has made nothing worth keeping.
          if (!returning) {
            await ctx.repository.deleteUserAndData(principal.userId);
            clearSessionCookie(reply, ctx);
          }
          throw err;
        }
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get('/v1/trips/:id', async (req, reply) => {
    try {
      const { session, run } = await service.getTripWithRun(idParam(req), actor(req));
      return reply.send({ trip: publicView(session), run });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/v1/trips', async (req, reply) => {
    try {
      const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
      // Someone with no session has no trips, which is an answer, not an error.
      if (!req.principal) return reply.send({ trips: [] });
      const trips = await service.listTrips(req.principal, limit);
      return reply.send({ trips: publicView(trips) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** The next question to ask, decided by the engine from what is known. */
  app.get('/v1/trips/:id/question', async (req, reply) => {
    try {
      const session = await service.getTrip(idParam(req), actor(req));
      return reply.send({
        questionnaire: session.questionnaire,
        classification: session.classification,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/v1/trips/:id/answers', async (req, reply) => {
    try {
      const session = await service.answer(idParam(req), actor(req), req.body);
      return reply.send({ trip: publicView(session), questionnaire: session.questionnaire });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * Starts the search and returns at once. Searching fans out to every
   * connected provider and takes a while, so it runs in the background:
   * watch `GET /v1/trips/:id/runs/:runId`, and read the plans from the trip
   * when it has succeeded.
   */
  app.post(
    '/v1/trips/:id/plan',
    { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
    async (req, reply) => {
      try {
        const result = await service.plan(idParam(req), actor(req));
        return reply.status(202).send({
          run: runView(result.run),
          reused: result.reused,
          // Pins that could not be kept for this search, each with the reason.
          pinsReleased: result.pinsReleased,
          trip: publicView(result.session),
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get('/v1/trips/:id/runs/:runId', async (req, reply) => {
    try {
      const { runId } = z.object({ runId: z.string().uuid() }).parse(req.params);
      return reply.send({ run: await service.getRun(idParam(req), actor(req), runId) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Stops a search. Idempotent: cancelling one that is over just returns it. */
  app.post('/v1/trips/:id/runs/:runId/cancel', async (req, reply) => {
    try {
      const { runId } = z.object({ runId: z.string().uuid() }).parse(req.params);
      return reply.status(202).send({ run: await service.cancelRun(idParam(req), actor(req), runId) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/v1/trips/:id/select', async (req, reply) => {
    try {
      const { planId } = z.object({ planId: z.string() }).parse(req.body);
      return reply.send({ trip: publicView(await service.selectPlan(idParam(req), actor(req), planId)) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * Which parts of the selected plan to keep through a re-plan. Replaces the
   * whole set; the answer lists any that could not be pinned, with why.
   */
  app.put('/v1/trips/:id/pins', async (req, reply) => {
    try {
      const { pins } = z.object({ pins: z.array(TripComponent).max(5) }).parse(req.body);
      const { session, refused } = await service.setPins(idParam(req), actor(req), pins);
      return reply.send({ trip: publicView(session), refused });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** "Make it cheaper", "use the train", "keep the hotel but change the flight". */
  app.post(
    '/v1/trips/:id/modify',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      try {
        const id = idParam(req);
        const { utterance } = z.object({ utterance: z.string().min(1).max(500) }).parse(req.body);
        const outcome = await service.modify(id, actor(req), utterance);
        // Logged for operators, never returned: a silent fall back to keyword
        // rules, or a model proposing values that fail validation, is exactly
        // what should be noticed, and neither is the traveller's concern.
        const { llmFallbackReason, rejectedParameters } = outcome.diagnostics;
        if (llmFallbackReason) {
          req.log.warn({ tripId: id, reason: llmFallbackReason }, 'Modification handled by rules: model unavailable');
        }
        if (rejectedParameters.length > 0) {
          req.log.warn({ tripId: id, rejectedParameters }, 'Modification parameters failed validation and were dropped');
        }
        return reply.send({ ...modificationBody(outcome), understoodBy: outcome.understoodBy });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  /**
   * The traveller's answer to a change that needed their say-so. Answering a
   * question that is no longer pending returns 409 and changes nothing.
   */
  app.post('/v1/trips/:id/modify/consent', async (req, reply) => {
    try {
      const { pendingModificationId, accept } = z
        .object({ pendingModificationId: z.string().uuid(), accept: z.boolean() })
        .parse(req.body);
      const outcome = await service.consent(idParam(req), actor(req), pendingModificationId, accept);
      return reply.send(modificationBody(outcome));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/v1/trips/:id', async (req, reply) => {
    try {
      await service.deleteTrip(idParam(req), actor(req));
      return reply.status(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get(
    '/v1/places',
    { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } },
    async (req, reply) => {
      try {
        const { q } = z.object({ q: z.string().min(2).max(120) }).parse(req.query);
        return reply.send({ places: await service.searchPlaces(q) });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  return service;
}

/** The response shape shared by a modification and the answer to its question. */
function modificationBody(outcome: Omit<ModificationResult, 'understoodBy' | 'diagnostics'>) {
  return {
    trip: publicView(outcome.session),
    status: outcome.status,
    interpretation: outcome.interpretation,
    reSearched: outcome.reSearched,
    kept: outcome.kept,
    // Pins that could not be honoured, with why: shown, never silently dropped.
    released: outcome.released,
    consent: outcome.consent,
    run: outcome.run,
    plans: publicView(outcome.session.plans),
  };
}

