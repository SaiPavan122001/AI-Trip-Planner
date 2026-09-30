/**
 * One vocabulary for "what kind of failure was that", used identically in logs
 * (`errorCategory`), metrics (`category` labels), traces (`error.category`) and
 * the `X-Error-Category` response header. It is coarser than an error code on
 * purpose: it says which team or dashboard should care, and it is a closed
 * list, so it is safe as a metric label.
 */

export const ERROR_CATEGORIES = [
  /** The caller sent something invalid. */
  'validation',
  'authentication',
  /** Understood, and not allowed (wrong owner's trip is `not_found`, by design; this is origin checks and the like). */
  'authorization',
  'not_found',
  /** Two changes collided, an idempotency key was reused, a state does not allow it. */
  'conflict',
  /** A travel provider did not answer, or refused. */
  'provider_unavailable',
  'provider_timeout',
  'provider_invalid_response',
  /** A provider rejected what this planner asked (bad parameters, rejected credentials). */
  'provider_rejected',
  /** This service's own limits, or a provider's, said to slow down. */
  'rate_limited',
  /** The database, Redis, the mail service or the language model is not answering. */
  'dependency_unavailable',
  /** The queue is full: turned away rather than accepted and dropped. */
  'queue_overloaded',
  'cancelled',
  'unsupported',
  'internal_error',
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

let includeMessages = true;

/**
 * Whether `describeError` includes an error's message. Off in production by
 * default: messages routinely quote input (a validation error repeats the value
 * it rejected; a driver error repeats a query), and what a traveller wrote must
 * not reach a log by way of an exception.
 */
export function configureErrorDetail(messages: boolean): void {
  includeMessages = messages;
}

/**
 * What is safe to log about a thrown value: its class, its category, the top of
 * its stack (file names and lines, which say where and nothing about what), and,
 * only if configured, its message.
 */
export function describeError(err: unknown): { errorType: string; errorCategory: ErrorCategory; errorFrames?: string[]; errorMessage?: string } {
  const category = categoryOfError(err);
  if (!(err instanceof Error)) return { errorType: typeof err, errorCategory: category };
  const frames = (err.stack ?? '')
    .split('\n')
    .slice(1, 6)
    .map((l) => l.trim().slice(0, 200));
  return {
    errorType: err.name,
    errorCategory: category,
    ...(frames.length ? { errorFrames: frames } : {}),
    ...(includeMessages ? { errorMessage: err.message.slice(0, 500) } : {}),
  };
}

/** The category of a provider outcome, or null when it is not a fault (nothing found is an answer). */
export function categoryOfProviderStatus(status: string): ErrorCategory | null {
  switch (status) {
    case 'ok':
    case 'no_availability':
    case 'unsupported_route':
    case 'unsupported_capability':
      return null;
    case 'timeout':
      return 'provider_timeout';
    case 'invalid_response':
      return 'provider_invalid_response';
    case 'rate_limited':
      return 'rate_limited';
    case 'invalid_request':
    case 'not_configured':
      return 'provider_rejected';
    default:
      return 'provider_unavailable';
  }
}

/** The category of an HTTP answer this service gave, from its status and its own error code. */
export function categoryOfHttp(status: number, code?: string): ErrorCategory | null {
  if (status < 400) return null;
  if (code === 'busy') return 'queue_overloaded';
  if (code === 'provider_unavailable') return 'provider_unavailable';
  if (status === 401) return 'authentication';
  if (status === 403) return 'authorization';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status === 501) return 'unsupported';
  if (status === 400 || status === 413 || status === 415 || status === 422) return 'validation';
  if (status === 503 || status === 504) return 'dependency_unavailable';
  if (status >= 500) return 'internal_error';
  return 'validation';
}

/**
 * The category of a thrown value, recognised by name and shape so this package
 * needs to import nothing from the code that throws.
 */
export function categoryOfError(err: unknown): ErrorCategory {
  if (typeof err !== 'object' || err === null) return 'internal_error';
  const e = err as { name?: unknown; statusCode?: unknown; code?: unknown };
  switch (e.name) {
    case 'AbortError':
    case 'RequestAbortedError':
    case 'RunCancelled':
      return 'cancelled';
    case 'TimeoutError':
    case 'TimeBudgetExceeded':
    case 'RunTimedOut':
      return 'provider_timeout';
    case 'InvalidResponseError':
    case 'RedirectRefusedError':
      return 'provider_invalid_response';
    case 'ZodError':
      return 'validation';
    case 'TripChangedError':
    case 'BookingChangedError':
      return 'conflict';
    case 'NetworkError':
    case 'LlmUnavailableError':
    case 'LlmInvalidOutputError':
    case 'MailDeliveryError':
      return 'dependency_unavailable';
    case 'PacerBackpressureError':
    case 'RequestLimitError':
      return 'rate_limited';
  }
  if (typeof e.statusCode === 'number') {
    return categoryOfHttp(e.statusCode, typeof e.code === 'string' ? e.code : undefined) ?? 'internal_error';
  }
  return 'internal_error';
}
