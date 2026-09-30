import type { FastifyReply } from 'fastify';
import { categoryOfHttp, describeError, metrics } from '@trip/telemetry';
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
    /** Sent as `Retry-After`: when it is worth asking again. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The service is at capacity: turned away now, not queued to fail later. */
  static busy(message: string, retryAfterSeconds: number): ApiError {
    return new ApiError(503, 'busy', message, { retryAfterSeconds }, retryAfterSeconds);
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

const FRAMEWORK_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, code: 'payload_too_large', message: 'That request is larger than this service accepts.' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, code: 'unsupported_media_type', message: 'Send the request as application/json.' },
  FST_ERR_CTP_INVALID_JSON: { status: 400, code: 'invalid_json', message: 'The request body was not valid JSON.' },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: { status: 400, code: 'bad_request', message: 'The request body did not match its declared length.' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, code: 'invalid_json', message: 'The request body was empty.' },
};

/**
 * Reports an error answer in the shared vocabulary (`@trip/telemetry`
 * `ErrorCategory`): the `X-Error-Category` header, so a client or a proxy log
 * can tell a validation error from an outage without parsing the body, and a
 * metric. The body is unchanged and says nothing more than it did.
 */
export function labelled(reply: FastifyReply, status: number, code?: string): FastifyReply {
  const category = categoryOfHttp(status, code);
  if (category) {
    reply.header('x-error-category', category);
    metrics.errors.inc({ category, component: 'api' });
  }
  return reply;
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
    if (err.retryAfterSeconds !== undefined) reply.header('retry-after', String(err.retryAfterSeconds));
    return labelled(reply, err.statusCode, err.code).status(err.statusCode).send(body);
  }

  // Two edits to one trip collided and this one lost. Nothing was changed.
  if (err instanceof TripChangedError) {
    return labelled(reply, 409, 'trip_changed').status(409).send({
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
    return labelled(reply, 400, 'validation_failed').status(400).send(body);
  }

  // Fastify's own errors (bad JSON, payload too large, an unsupported content
  // type) carry the right status; reporting them as 500 would tell a client
  // their request was fine and we broke, when the opposite is true. What they
  // *say* is not passed on: the framework's messages quote the input and its
  // internals, and a client is better served by a fixed sentence per case.
  const fastifyError = err as { statusCode?: number; code?: string };
  if (
    typeof fastifyError.statusCode === 'number' &&
    fastifyError.statusCode >= 400 &&
    fastifyError.statusCode < 500
  ) {
    const known = FRAMEWORK_ERRORS[fastifyError.code ?? ''] ?? (err instanceof SyntaxError ? FRAMEWORK_ERRORS['FST_ERR_CTP_INVALID_JSON'] : undefined);
    return labelled(reply, known ? known.status : fastifyError.statusCode, known?.code).status(known ? known.status : fastifyError.statusCode).send({
      error: {
        code: known?.code ?? 'bad_request',
        message: known?.message ?? 'That request could not be processed.',
      },
    } satisfies ApiErrorBody);
  }

  reply.log.error({ operation: 'http.request', ...describeError(err) }, 'Unhandled error');
  labelled(reply, 500);
  const body: ApiErrorBody = {
    error: {
      code: 'internal_error',
      message: 'Something went wrong on our side. Nothing was booked or charged.',
    },
  };
  return reply.status(500).send(body);
}
