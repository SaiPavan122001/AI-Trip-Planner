import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { TripChangedError } from './repository/types.js';

/**
 * A single error shape for the whole API. Clients get a machine-readable
 * `code`, a sentence they can show a traveller, and, for validation failures,
 * exactly which field was wrong. Nothing here leaks a stack trace or a
 * provider's internal error body.
 */

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    /** Present when the failure came from a travel provider. */
    provider?: { id: string; label: string; status: string };
  };
}

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static notFound(what: string): ApiError {
    return new ApiError(404, 'not_found', `${what} was not found.`);
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, 'bad_request', message, details);
  }

  static conflict(message: string, code = 'conflict', details?: unknown): ApiError {
    return new ApiError(409, code, message, details);
  }

  static unauthorized(message = 'Sign in to do that.'): ApiError {
    return new ApiError(401, 'unauthorized', message);
  }

  static tooManyRequests(code: string, message: string, details?: unknown): ApiError {
    return new ApiError(429, code, message, details);
  }

  /** Understood and well-formed, but the caller may never perform it. */
  static forbidden(code: string, message: string): ApiError {
    return new ApiError(403, code, message);
  }

  static unprocessable(message: string, details?: unknown): ApiError {
    return new ApiError(422, 'unprocessable', message, details);
  }

  /** The traveller asked for something no connected provider can answer. */
  static providerUnavailable(provider: string, label: string, status: string, message: string): ApiError {
    const err = new ApiError(503, 'provider_unavailable', message);
    (err as ApiError & { provider?: unknown }).provider = { id: provider, label, status };
    return err;
  }
}

export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ApiError) {
    const body: ApiErrorBody = {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details === undefined ? {} : { details: err.details }),
        ...((err as ApiError & { provider?: ApiErrorBody['error']['provider'] }).provider
          ? { provider: (err as ApiError & { provider: ApiErrorBody['error']['provider'] }).provider }
          : {}),
      },
    };
    return reply.status(err.statusCode).send(body);
  }

  // Two edits to one trip collided and this one lost. Nothing was changed.
  if (err instanceof TripChangedError) {
    return reply.status(409).send({
      error: { code: 'trip_changed', message: err.message },
    } satisfies ApiErrorBody);
  }

  if (err instanceof ZodError) {
    const body: ApiErrorBody = {
      error: {
        code: 'validation_failed',
        message: 'Some of the details sent were not valid.',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    };
    return reply.status(400).send(body);
  }

  // Fastify's own errors (bad JSON, payload too large, rate limit) already
  // carry the right status. Reporting them as 500 would tell a client their
  // request was fine and we broke, when the opposite is true.
  const fastifyError = err as { statusCode?: number; code?: string; message?: string };
  if (
    typeof fastifyError.statusCode === 'number' &&
    fastifyError.statusCode >= 400 &&
    fastifyError.statusCode < 500
  ) {
    return reply.status(fastifyError.statusCode).send({
      error: {
        code: fastifyError.code ?? 'bad_request',
        message: fastifyError.message ?? 'That request could not be processed.',
      },
    } satisfies ApiErrorBody);
  }

  reply.log.error({ err }, 'Unhandled error');
  const body: ApiErrorBody = {
    error: {
      code: 'internal_error',
      message: 'Something went wrong on our side. Nothing was booked or charged.',
    },
  };
  return reply.status(500).send(body);
}
