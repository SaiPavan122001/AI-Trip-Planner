import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { KnowledgeAnswer } from '@trip/knowledge';
import { cleanUntrustedText } from '@trip/shared';
import type { AppContext } from '../context.js';
import { ApiError, labelled, sendError } from '../errors.js';

/**
 * `POST /v1/knowledge/ask`: a question answered from the curated knowledge
 * index (policies, rules, guides), with citations, or "Insufficient verified
 * information." when nothing verified answers it.
 *
 * What it is not: it never answers about a price, a fare, a timetable,
 * availability, weather or the state of a booking: those come from providers, at
 * the moment they are needed, and are not in the index. It changes nothing (no
 * trip, no plan, no booking), so it needs no `Idempotency-Key`; it costs an
 * embedding and possibly a model call, so it needs a session and is rate limited
 * per person and per address.
 *
 * Which index is read is the operator's configuration (`KNOWLEDGE_NAMESPACE`);
 * nothing in the request can name one. A `tripId`, if given, must be the
 * caller's own trip (another person's is reported as not found), and only supplies
 * the destination to prefer.
 */

const text = (max: number) =>
  z
    .string()
    .max(max * 4)
    .transform((s) => cleanUntrustedText(s, { maxLength: max }))
    .pipe(z.string().min(1).max(max));

const askBody = z
  .object({
    question: text(500),
    destination: text(80).optional(),
    tripId: z.string().uuid().optional(),
  })
  .strict();

/** What a caller sees of an answer: the answer, what it rests on, and what was and was not found. The pipeline's own numbers stay inside. */
export function publicAnswer(a: KnowledgeAnswer) {
  return {
    status: a.status,
    answer: a.answer,
    claims: a.claims,
    citations: a.citations,
    conflicts: a.conflicts,
    notes: a.notes,
    mode: a.mode,
    insufficientReason: a.insufficientReason,
  };
}

export function registerKnowledgeRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/v1/knowledge/ask', { config: { limit: 'knowledge.ask' } }, async (req, reply) => {
    try {
      // Not switched on: as though it did not exist.
      if (!ctx.knowledge) throw ApiError.notFound('That page');
      if (!req.principal) throw ApiError.unauthorized();
      const body = askBody.parse(req.body);

      let destination = body.destination;
      if (body.tripId) {
        const trip = await ctx.repository.getSession(body.tripId);
        if (!trip || trip.ownerId !== req.principal.userId) throw ApiError.notFound('That trip');
        destination ??= trip.intent.destination.name;
      }

      // Stopped if the caller goes away.
      const gone = new AbortController();
      req.raw.once('close', () => gone.abort());
      try {
        const answer = await ctx.knowledge.ask(body.question, destination, gone.signal);
        return reply.send({ answer: publicAnswer(answer) });
      } catch (err) {
        if (err instanceof ApiError) throw err;
        // The index or the embedder failed. The failure is logged (by the service, with its category); the caller is told only that
        // this is unavailable, and that nothing about their trip is affected.
        return labelled(reply, 503, 'knowledge_unavailable').status(503).send({
          error: { code: 'knowledge_unavailable', message: 'Answers from the knowledge base are unavailable right now. Your trip is not affected.' },
        });
      }
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
