import { z } from 'zod';

/**
 * A background search, as a client sees it. Searching fans out to several
 * providers and can take a minute, so it runs apart from the request that
 * asked for it: the request returns at once with a run, and the client watches
 * the run until it finishes.
 */

export const RunKind = z.enum(['plan', 'replan']);
export type RunKind = z.infer<typeof RunKind>;

/**
 * queued: waiting for a worker. running: a worker is searching.
 * succeeded: the plans are saved on the trip.
 * failed: nothing could be built; `error` says why.
 * cancelled: the traveller stopped it.
 * superseded: it finished, but the trip changed meanwhile, so its plans were
 * thrown away rather than shown against the wrong trip.
 */
export const RunStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'superseded']);
export type RunStatus = z.infer<typeof RunStatus>;

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running'];
export const isActiveRun = (status: RunStatus): boolean => ACTIVE_RUN_STATUSES.includes(status);

export const RunProgress = z.object({
  /** Stable machine name of the step, for the client to key on. */
  step: z.string(),
  /** Plain words for the traveller: "Searching flights". */
  label: z.string(),
  percent: z.number().min(0).max(100),
});
export type RunProgress = z.infer<typeof RunProgress>;

export const RunError = z.object({ code: z.string(), message: z.string() });
export type RunError = z.infer<typeof RunError>;

export const PlanningRunView = z.object({
  id: z.string().uuid(),
  tripId: z.string().uuid(),
  kind: RunKind,
  status: RunStatus,
  progress: RunProgress.nullable(),
  error: RunError.nullable(),
  cancelRequested: z.boolean(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
});
export type PlanningRunView = z.infer<typeof PlanningRunView>;
