import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { ApiError } from '../errors.js';
import { canonicalJson } from '../util/canonical.js';
import { securityEvent } from './events.js';

/**
 * Idempotency for the requests where doing the work twice does harm.
 *
 * A client that does not get an answer (a dropped connection, a double click, a
 * retrying proxy) cannot tell whether its request was carried out, and asking
 * again must not carry it out a second time. A request that carries an
 * `Idempotency-Key` header is claimed in the database first:
 *
 *   - the first request with a key does the work and its answer is stored;
 *   - the same key with the same request again gets that stored answer back,
 *     marked `Idempotent-Replay: true`, without doing the work;
 *   - the same key while the first is still running is refused with 409 (the
 *     client waits and asks again), so two requests racing cannot both act;
 *   - the same key with a *different* request is refused with 422: it is a bug
 *     in the client, and answering either request would be wrong.
 *
 * The claim is scoped to the person, the route and the target (a trip), so one
 * caller's key can never replay, block or see another's. A request that fails
 * releases its key, so it can be retried with the same one.
 *
 * Only unsafe requests that create or change something use it: creating a
 * trip, starting a search, a change request and its consent, cancelling, and
 * asking for a sign-in email. Reads do not: repeating a GET does no harm.
 */

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

export interface IdempotentAnswer {
  status: number;
  body: unknown;
}

export interface IdempotencyScope {
  /** What this request is: the route and the thing it acts on, e.g. `POST /v1/trips/:id/plan:<tripId>`. */
  scope: string;
  /** The person, when there is one; the claim is theirs alone. */
  principalId: string | null;
}

/** The key a client sent, checked; null if it sent none. */
export function idempotencyKeyOf(req: FastifyRequest): string | null {
  const raw = req.headers['idempotency-key'];
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !KEY_PATTERN.test(raw)) {
    throw ApiError.badRequest('The Idempotency-Key header must be 8 to 128 characters: letters, digits and - _ . :');
  }
  return raw;
}

/**
 * Runs `work` once per key. With no key, it simply runs. Sends the answer
 * (fresh or replayed) on `reply`.
 */
export async function idempotently(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  where: IdempotencyScope,
  work: () => Promise<IdempotentAnswer>,
): Promise<FastifyReply> {
  const key = idempotencyKeyOf(req);
  if (key === null) {
    const fresh = await work();
    return reply.status(fresh.status).send(fresh.body);
  }

  const claim = { principal: where.principalId, scope: where.scope, key };
  const requestHash = createHash('sha256')
    .update(canonicalJson({ scope: where.scope, params: req.params ?? null, body: req.body ?? null }))
    .digest('hex');
  const store = ctx.repository;

  const outcome = await store.claimIdempotencyKey({ ...claim, requestHash });
  switch (outcome.status) {
    case 'completed': {
      const stored = outcome.response as IdempotentAnswer;
      reply.header('idempotent-replay', 'true');
      return reply.status(stored.status).send(stored.body);
    }
    case 'in_progress':
      reply.header('retry-after', '2');
      throw new ApiError(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still being processed. Wait a moment and ask again.');
    case 'mismatch':
      securityEvent(ctx.logger, 'idempotency_conflict', { route: where.scope, method: req.method, address: req.addressTag, userId: where.principalId });
      throw new ApiError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different request. Use a new key for a new request.');
    case 'claimed':
      break;
  }

  let answer: IdempotentAnswer;
  try {
    answer = await work();
  } catch (err) {
    // Whatever went wrong, the work was not done; the client may try again with the same key.
    await store.releaseIdempotencyKey(claim).catch(() => undefined);
    throw err;
  }
  // Only what actually succeeded is remembered. A server error is not an
  // answer to replay.
  if (answer.status < 400) {
    // The work is done. If remembering it fails, the client still gets its answer;
    // the claim simply expires, and a retry in the meantime is told to wait.
    await store.completeIdempotencyKey(claim, answer).catch((err: unknown) => {
      ctx.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Could not record the answer for an Idempotency-Key');
    });
  } else await store.releaseIdempotencyKey(claim).catch(() => undefined);
  return reply.status(answer.status).send(answer.body);
}
