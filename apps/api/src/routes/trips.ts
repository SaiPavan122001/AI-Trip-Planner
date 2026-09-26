import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ApiError, sendError } from '../errors.js';
import { TripService, type ModificationResult } from '../services/trip-service.js';

/**
 * Trip planning endpoints, in the order a traveller meets them:
 * create -> answer questions -> plan -> compare -> modify.
 */
export function registerTripRoutes(app: FastifyInstance, ctx: AppContext): void {
  const service = new TripService({
    registry: ctx.registry,
    llm: ctx.llm,
    repository: ctx.repository,
  });

  const ownerOf = (req: { headers: Record<string, unknown> }): string | null => {
    // Anonymous planning is deliberately allowed: making someone sign up
    // before they can see whether a trip is even feasible is hostile.
    const header = req.headers['x-user-id'];
    return typeof header === 'string' && header.length > 0 ? header : null;
  };

  app.post('/v1/trips', async (req, reply) => {
    try {
      const session = await service.createTrip(req.body, ownerOf(req));
      return reply.status(201).send({ trip: session });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/v1/trips/:id', async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return reply.send({ trip: await service.getTrip(id) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/v1/trips', async (req, reply) => {
    try {
      const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(
        req.query,
      );
      const trips = await ctx.repository.listSessions(ownerOf(req), limit);
      return reply.send({ trips });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** The next question to ask, decided by the engine from what is known. */
  app.get('/v1/trips/:id/question', async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const session = await service.getTrip(id);
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
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const session = await service.answer(id, req.body);
      return reply.send({ trip: session, questionnaire: session.questionnaire });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * Runs the whole pipeline. This is the slow endpoint: it fans out to every
   * connected provider, so it carries its own timeout rather than relying on
   * the client giving up.
   */
  app.post('/v1/trips/:id/plan', async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const planning = service.plan(id);
      const timeout = new Promise<never>((_, rejectPlan) =>
        setTimeout(
          () =>
            rejectPlan(
              new ApiError(
                504,
                'planning_timeout',
                'The search took too long and was stopped. Some providers may be slow right now; try again.',
              ),
            ),
          ctx.env.PLANNING_TIMEOUT_MS,
        ),
      );

      const { session, result } = await Promise.race([planning, timeout]);
      return reply.send({
        trip: session,
        plans: result.plans,
        comparison: {
          outbound: summariseSearch(result.transport.outbound),
          inbound: result.transport.inbound ? summariseSearch(result.transport.inbound) : null,
        },
        hotels: {
          considered: result.hotels.candidates.length,
          filtered: result.hotels.filtered,
        },
        budgetConflict: result.budgetConflict,
        providerNotes: session.providerNotes,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/v1/trips/:id/select', async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { planId } = z.object({ planId: z.string() }).parse(req.body);
      return reply.send({ trip: await service.selectPlan(id, planId) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** "Make it cheaper", "use the train", "keep the hotel but change the flight". */
  app.post('/v1/trips/:id/modify', async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { utterance } = z
        .object({ utterance: z.string().min(1).max(500) })
        .parse(req.body);
      const outcome = await service.modify(id, utterance);
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
  });

  /**
   * The traveller's answer to a change that needed their say-so. Answering a
   * question that is no longer pending returns 409 and changes nothing.
   */
  app.post('/v1/trips/:id/modify/consent', async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { pendingModificationId, accept } = z
        .object({ pendingModificationId: z.string().uuid(), accept: z.boolean() })
        .parse(req.body);
      const outcome = await service.consent(id, pendingModificationId, accept);
      return reply.send(modificationBody(outcome));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/v1/trips/:id', async (req, reply) => {
    try {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      await ctx.repository.deleteSession(id);
      return reply.status(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/v1/places', async (req, reply) => {
    try {
      const { q } = z.object({ q: z.string().min(2).max(120) }).parse(req.query);
      return reply.send({ places: await service.searchPlaces(q) });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

/**
 * The mode comparison the UI shows before anyone picks a way of travelling.
 * Modes with nothing to show carry the reason why, so the screen can say
 * "no rail provider is connected" instead of silently omitting rail.
 */
function summariseSearch(search: {
  date: string;
  modes: Array<{
    mode: string;
    offers: Array<{ candidate: unknown; score: number }>;
    cheapest: unknown;
    fastest: unknown;
    bestForYou: unknown;
    note: unknown;
  }>;
  filtered: Array<{ offerId: string; reason: string }>;
}) {
  return {
    date: search.date,
    modes: search.modes.map((m) => ({
      mode: m.mode,
      optionCount: m.offers.length,
      cheapest: m.cheapest,
      fastest: m.fastest,
      bestForYou: m.bestForYou,
      allOffers: m.offers.slice(0, 10),
      unavailableReason: m.note,
    })),
    filteredByYourRequirements: search.filtered,
  };
}

/** The response shape shared by a modification and the answer to its question. */
function modificationBody(outcome: Omit<ModificationResult, 'understoodBy' | 'diagnostics'>) {
  return {
    trip: outcome.session,
    status: outcome.status,
    interpretation: outcome.interpretation,
    reSearched: outcome.reSearched,
    kept: outcome.kept,
    released: outcome.released,
    consent: outcome.consent,
    plans: outcome.result?.plans ?? outcome.session.plans,
    budgetConflict: outcome.result?.budgetConflict ?? null,
  };
}
