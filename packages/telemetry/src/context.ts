import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Correlation: the identifiers that let an engineer follow one thing through
 * the system.
 *
 *   HTTP request  (requestId)
 *     -> planning run  (runId, trip)
 *       -> workflow, agents, provider calls, model calls, store operations
 *
 * `requestId` names the HTTP request; `runId` the background search it queued;
 * `tripId` the trip (a random UUID, not personal data). `traceId`/`spanId` come
 * from the active trace (see `tracing.ts`) and are added to every log line
 * beside these.
 *
 * The context travels with the asynchronous work (`AsyncLocalStorage`), so
 * code deep in an adapter that logs or measures something is attributed to the
 * right request or run without anyone passing an id down. A queued run is
 * picked up later, perhaps by another process: its correlation is rebuilt from
 * what was stored with the run (`RunService`), so the search continues the
 * request's trace rather than starting an unrelated one.
 *
 * Nothing here holds anything a person wrote. An identifier is checked before
 * it is accepted, so it can never be used to smuggle text into a log line or a
 * metric.
 */

export interface Correlation {
  requestId?: string;
  runId?: string;
  tripId?: string;
}

const storage = new AsyncLocalStorage<Correlation>();

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** An identifier if it is well formed, else undefined. */
export function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : undefined;
}

function clean(patch: Correlation): Correlation {
  const out: Correlation = {};
  const requestId = safeId(patch.requestId);
  const runId = safeId(patch.runId);
  const tripId = safeId(patch.tripId);
  if (requestId) out.requestId = requestId;
  if (runId) out.runId = runId;
  if (tripId) out.tripId = tripId;
  return out;
}

export function currentCorrelation(): Correlation {
  return storage.getStore() ?? {};
}

/** Runs `fn` with these identifiers added to whatever the caller already had. */
export function withCorrelation<T>(patch: Correlation, fn: () => T): T {
  return storage.run({ ...currentCorrelation(), ...clean(patch) }, fn);
}
