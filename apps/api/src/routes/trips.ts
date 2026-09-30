import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TripComponent, cleanUntrustedText, type PlanningSession } from '@trip/shared';
import { clearSessionCookie, startAnonymousSession } from '../auth/plugin.js';
import type { AuthService, Principal } from '../auth/service.js';
import type { AppContext } from '../context.js';
import { ApiError, sendError } from '../errors.js';
import { idempotently } from '../security/idempotency.js';
import { runView, type Actor } from '../services/run-service.js';
import { TripService, type ModificationResult } from '../services/trip-service.js';
import { publicView } from '../util/public.js';

/**
 * Trip planning endpoints, in the order a traveller meets them:
 * create -> answer questions -> plan -> compare -> modify.
 *
 * Every trip belongs to the person who made it. A trip that is somebody
 * else's is reported exactly as one that does not exist.
 *
 * What makes a route safe to expose is decided here and in `server.ts`, once,
 * for all of them: every body is a strict schema (a field nobody asked for is
 * an error, not something quietly assigned), every string has a maximum, ids
 * are UUIDs, the person acting comes from the session and never from the
 * request, and the routes that cost money or change something carry a named
 * rate limit (`config.limit`) and, where doing it twice would do harm, an
 * `Idempotency-Key`.
 */

/** A trip as the list shows it: enough to recognise it and open it, and nothing heavy. */
export interface TripSummary {
  id: string;
  stage: PlanningSession['stage'];
  origin: string;
  destination: string;
  departureDate: string;
  returnDate: string | null;
  planCount: number;
  updatedAt: string;
}

export function summaryOf(session: PlanningSession): TripSummary {
  return {
    id: session.id,
    stage: session.stage,
    origin: session.intent.origin.name,
    destination: session.intent.destination.name,
    departureDate: session.intent.departureDate,
    returnDate: session.intent.returnDate,
    planCount: session.plans.length,
    updatedAt: session.updatedAt,
  };
}

/** Free text from a person: hidden characters removed, one line, and never longer than said. */
const freeText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => cleanUntrustedText(s))
    .pipe(z.string().min(1).max(max));

export function registerTripRoutes(app: FastifyInstance, ctx: AppContext, auth: AuthService): TripService {
  const service = new TripService({
    registry: ctx.registry,
    llm: ctx.llm,
    repository: ctx.repository,
    runs: ctx.runs,
    agentTimeoutMs: ctx.env.AGENT_TIMEOUT_MS,
  });

  /**
   * Who is asking; refuses if nobody is signed in. Reading someone's trip needs
   * a session. The address goes with them, as a keyed tag, so the per-address
   * allowance can be applied to anonymous people.
   */
  const actor = (req: FastifyRequest): Actor & Principal => {
    if (!req.principal) throw ApiError.notFound('That trip');
    return { ...req.principal, address: req.addressTag };
  };

  const idParam = (req: FastifyRequest) => z.object({ id: z.string().uuid() }).parse(req.params).id;

  app.post(
    '/v1/trips',
    // Someone with no session is counted by address, tightly, which bounds how
    // many throwaway sessions (each with its own daily searches) one address
    // can make: this is the door the cookie-clearing trick goes through.
    { config: { limit: 'trips.create' } },
    async (req, reply) => {
      try {
        // Anonymous planning is deliberately allowed: making someone sign up
        // before they can see whether a trip is even feasible is hostile. They
        // get a private session instead, and can sign in later to keep it.
        const returning = req.principal;
        const principal = returning ?? (await startAnonymousSession(req, reply, ctx, auth));
        try {
          return await idempotently(
            ctx,
            req,
            reply,
            { scope: 'POST /v1/trips', principalId: principal.userId },
            async () => {
              const session = await service.createTrip(req.body, principal);
              return { status: 201, body: { trip: publicView(session) } };
            },
          );
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

  /** The person's trips, newest first, as summaries: the whole document of every trip is not needed to pick one. */
  app.get('/v1/trips', async (req, reply) => {
    try {
      const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
      // Someone with no session has no trips, which is an answer, not an error.
      if (!req.principal) return reply.send({ trips: [] });
      const trips = await service.listTrips(req.principal, limit);
      return reply.send({ trips: trips.map(summaryOf) });
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
   *
   * With an `Idempotency-Key`, asking again (a retry, a double click) answers
   * with the first answer and starts nothing. Without one, asking again while a
   * search for the same trip is running still starts nothing: it returns that
   * search with `reused: true`.
   */
  app.post(
    '/v1/trips/:id/plan',
    { config: { limit: 'trips.plan' } },
    async (req, reply) => {
      try {
        const id = idParam(req);
        const who = actor(req);
        z.object({}).strict().parse(req.body ?? {});
        return await idempotently(ctx, req, reply, { scope: `POST /v1/trips/:id/plan:${id}`, principalId: who.userId }, async () => {
          const result = await service.plan(id, who);
          return {
            status: 202,
            body: {
              run: runView(result.run),
              reused: result.reused,
              // Pins that could not be kept for this search, each with the reason.
              pinsReleased: result.pinsReleased,
              trip: publicView(result.session),
            },
          };
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
      const id = idParam(req);
      const who = actor(req);
      return await idempotently(ctx, req, reply, { scope: `POST /v1/trips/:id/runs/:runId/cancel:${id}:${runId}`, principalId: who.userId }, async () => ({
        status: 202,
        body: { run: await service.cancelRun(id, who, runId) },
      }));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/v1/trips/:id/select', async (req, reply) => {
    try {
      const { planId } = z.object({ planId: z.string().min(1).max(100) }).strict().parse(req.body);
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
      const { pins } = z.object({ pins: z.array(TripComponent).max(5) }).strict().parse(req.body);
      const { session, refused } = await service.setPins(idParam(req), actor(req), pins);
      return reply.send({ trip: publicView(session), refused });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** "Make it cheaper", "use the train", "keep the hotel but change the flight". */
  app.post(
    '/v1/trips/:id/modify',
    { config: { limit: 'trips.modify' } },
    async (req, reply) => {
      try {
        const id = idParam(req);
        const who = actor(req);
        const { utterance } = z.object({ utterance: freeText(500) }).strict().parse(req.body);
        return await idempotently(ctx, req, reply, { scope: `POST /v1/trips/:id/modify:${id}`, principalId: who.userId }, async () => {
          const outcome = await service.modify(id, who, utterance);
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
          return { status: 200, body: { ...modificationBody(outcome), understoodBy: outcome.understoodBy } };
        });
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
        .strict()
        .parse(req.body);
      const id = idParam(req);
      const who = actor(req);
      return await idempotently(ctx, req, reply, { scope: `POST /v1/trips/:id/modify/consent:${id}:${pendingModificationId}`, principalId: who.userId }, async () => ({
        status: 200,
        body: modificationBody(await service.consent(id, who, pendingModificationId, accept)),
      }));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  const requirementsBody = z.object({ message: freeText(2000) }).strict();

  /**
   * Reads a request written in plain language and says what was understood,
   * what is missing, and what conflicts. Changes nothing and creates nothing:
   * when the request is complete, `tripInput` is what to send to
   * `POST /v1/trips`. Each call may use a language model, so it is tightly
   * limited; it needs no session, as it stores nothing.
   */
  app.post(
    '/v1/requirements/interpret',
    { config: { limit: 'ai.read' } },
    async (req, reply) => {
      try {
        const { message } = requirementsBody.parse(req.body);
        const reading = await service.interpretRequirements(message);
        return reply.send({
          requirements: reading.requirements,
          missing: reading.requirements.missing,
          conflicts: reading.requirements.conflicts,
          tripInput: reading.tripInput,
          understoodBy: reading.understoodBy,
          droppedCount: reading.droppedCount,
          notes: reading.notes,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  /**
   * Applies what the traveller said, in words, to their own trip. Every part
   * goes through the ordinary answer path, so it is checked exactly as a click
   * would be; what cannot be applied is reported, with the reason, never
   * dropped. Changes to the trip's dates, places or party are reported as
   * `differences` and need the change flow, which asks first.
   */
  app.post(
    '/v1/trips/:id/requirements',
    { config: { limit: 'ai.read' } },
    async (req, reply) => {
      try {
        const id = idParam(req);
        const who = actor(req);
        const { message } = requirementsBody.parse(req.body);
        return await idempotently(ctx, req, reply, { scope: `POST /v1/trips/:id/requirements:${id}`, principalId: who.userId }, async () => {
          const result = await service.applyRequirements(id, who, message);
          return {
            status: 200,
            body: {
              trip: publicView(result.session),
              requirements: result.requirements,
              missing: result.requirements.missing,
              conflicts: result.requirements.conflicts,
              applied: result.applied,
              rejected: result.rejected,
              unmapped: result.unmapped,
              keptForPlanning: result.keptForPlanning,
              differences: result.differences,
              understoodBy: result.understoodBy,
              droppedCount: result.droppedCount,
              notes: result.notes,
            },
          };
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

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
    { config: { limit: 'places' } },
    async (req, reply) => {
      try {
        const { q } = z.object({ q: z.string().max(240).transform((s) => cleanUntrustedText(s, { maxLength: 120 })).pipe(z.string().min(2).max(120)) }).parse(req.query);
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
