import { z } from 'zod';
import type { Logger } from 'pino';
import { PlanningOrchestrator, type OrchestrationResult } from '@trip/agents';
import type { KeptComponents } from '@trip/engine';
import type { TripLlm } from '@trip/llm';
import type { ProviderRegistry } from '@trip/providers';
import {
  ActivityOffer,
  SelectedHotel,
  TransportOffer,
  type PlanningRunView,
  type PlanningSession,
  type ProviderNote,
  type RunKind,
  type RunProgress,
} from '@trip/shared';
import type { Env } from '../env.js';
import { ApiError } from '../errors.js';
import type { RunRecord, Store } from '../repository/store.js';
import { TripChangedError } from '../repository/types.js';
import { inputsHash } from '../util/canonical.js';
import { searchSummaryOf } from './search-summary.js';

/** The longest explanation stored per trip; longer text is cut, not refused. */
const MAX_SUMMARY = 1200;
const MAX_PLAN_TEXT = 1000;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Background planning.
 *
 * A search calls several travel providers and can take a minute, so it does
 * not run inside the request that asked for it. `RunService.enqueue` records
 * the request and returns at once; a worker (in this process or a separate
 * one) takes it, searches, and saves the plans on the trip. The traveller's
 * screen watches the run.
 *
 * Three rules keep this honest:
 *  - A trip has at most one active run, enforced by the store.
 *  - A run's plans are only saved if the trip still has the inputs the run
 *    started with; otherwise they are discarded ("superseded"), never shown
 *    against a trip they were not made for.
 *  - Whatever happens, the run ends in a state the traveller can read, and
 *    what they see never claims more than was done.
 */

/** What a run needs beyond the trip itself. Stored with the run, so validated on the way out. */
export const RunParams = z.object({
  /** Why the search was started, for the log. */
  reason: z.string().default(''),
  /** Pins that could not be kept for this search, so the explanation can say so. */
  pinsReleased: z.array(z.object({ component: z.string(), reason: z.string() })).default([]),
  /** Parts of the earlier plan to use exactly as they were. */
  keep: z
    .object({
      outbound: TransportOffer.nullable().default(null),
      return: TransportOffer.nullable().default(null),
      hotel: SelectedHotel.nullable().default(null),
      activities: z.array(ActivityOffer).nullable().default(null),
    })
    .default({}),
});
export type RunParams = z.infer<typeof RunParams>;

export interface Actor {
  userId: string;
  isAnonymous: boolean;
}

class RunCancelled extends Error {
  constructor() {
    super('The search was cancelled.');
  }
}
class RunTimedOut extends Error {
  constructor() {
    super('The search took too long.');
  }
}
/** Another worker owns the run now, or this process is shutting down. */
class RunLeaseLost extends Error {
  constructor() {
    super('This worker no longer owns the run.');
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function runView(run: RunRecord): PlanningRunView {
  return {
    id: run.id,
    tripId: run.tripId,
    kind: run.kind,
    status: run.status,
    progress: run.progress,
    error: run.error,
    cancelRequested: run.cancelRequested,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

export interface RunServiceDeps {
  store: Store;
  registry: ProviderRegistry;
  /** The model the planning agents use; with none configured they run on their rule-based fallbacks. */
  llm: TripLlm;
  env: Env;
  logger: Logger;
  /** Told when a run is queued, so an in-process worker can start at once instead of on its next poll. */
  onQueued?: () => void;
}

export class RunService {
  private readonly orchestrator: PlanningOrchestrator;

  constructor(private readonly deps: RunServiceDeps) {
    this.orchestrator = new PlanningOrchestrator({
      registry: deps.registry,
      agents: { llm: deps.llm, timeoutMs: deps.env.AGENT_TIMEOUT_MS },
    });
  }

  // ----------------------------------------------------------- requesting

  /**
   * Queues a search for a trip as it is now. Returns the existing run if the
   * trip is already being searched for exactly this, and refuses if it is
   * being searched for something else.
   */
  async enqueue(
    session: PlanningSession,
    actor: Actor,
    options: {
      kind: RunKind;
      keep?: Partial<KeptComponents>;
      reason: string;
      pinsReleased?: Array<{ component: string; reason: string }>;
    },
  ): Promise<{ run: RunRecord; reused: boolean }> {
    const { store } = this.deps;
    const hash = inputsHash(session);

    const active = await store.activeRunForTrip(session.id);
    if (active) return this.alreadyRunning(active, hash);

    await this.assertQuota(actor);

    const params: RunParams = RunParams.parse({
      reason: options.reason,
      keep: options.keep ?? {},
      pinsReleased: options.pinsReleased ?? [],
    });
    const queued = await store.enqueueRun({
      tripId: session.id,
      ownerId: actor.userId,
      kind: options.kind,
      inputsHash: hash,
      baseVersion: session.version,
      params: JSON.parse(JSON.stringify(params)) as Record<string, unknown>,
    });
    // Another request queued one in the meantime.
    if ('active' in queued) return this.alreadyRunning(queued.active, hash);

    this.deps.onQueued?.();
    await this.audit(session.id, actor.userId, 'run.queued', { runId: queued.run.id, kind: options.kind });
    return { run: queued.run, reused: false };
  }

  /** Each search calls paid provider APIs, so a person may start only so many a day. */
  async assertQuota(actor: Actor): Promise<void> {
    const { store, env } = this.deps;
    const limit = actor.isAnonymous ? env.PLAN_RUNS_PER_DAY_ANONYMOUS : env.PLAN_RUNS_PER_DAY_SIGNED_IN;
    const started = await store.countRunsSince(actor.userId, new Date(Date.now() - DAY_MS));
    if (started >= limit) {
      throw ApiError.tooManyRequests(
        'daily_search_limit',
        actor.isAnonymous
          ? `You have used today's ${limit} searches. Sign in to get more, or come back tomorrow.`
          : `You have used today's ${limit} searches. Please come back tomorrow.`,
        { limit },
      );
    }
  }

  private alreadyRunning(active: RunRecord, hash: string): { run: RunRecord; reused: boolean } {
    if (active.inputsHash === hash) return { run: active, reused: true };
    throw ApiError.conflict(
      'Your plans are still being built. Wait for them to finish, or stop the search first.',
      'run_in_progress',
      { run: runView(active) },
    );
  }

  /** Stops a run: at once if it has not started, at its next step if it has. */
  async cancel(runId: string): Promise<RunRecord | null> {
    return this.deps.store.requestCancel(runId);
  }

  // ------------------------------------------------------------ executing

  /**
   * Carries out one run this worker has claimed. It never throws: every
   * outcome, including a crash in planning, is recorded on the run.
   */
  async execute(run: RunRecord, workerId: string): Promise<void> {
    const { store, env, logger } = this.deps;
    const controller = new AbortController();
    const log = logger.child({ runId: run.id, tripId: run.tripId });
    const deadline = setTimeout(() => controller.abort(new RunTimedOut()), env.PLANNING_TIMEOUT_MS);

    // Renewing the lease is also how the worker hears it should stop.
    let chain: Promise<void> = Promise.resolve();
    const beat = (progress?: RunProgress) => {
      chain = chain
        .then(async () => {
          const res = await store.heartbeatRun(run.id, workerId, env.RUN_LEASE_MS, progress);
          if (!res.owned) controller.abort(new RunLeaseLost());
          else if (res.cancelRequested) controller.abort(new RunCancelled());
        })
        .catch((err: unknown) => log.warn({ err }, 'Could not renew a run lease'));
    };
    const heartbeat = setInterval(() => beat(), Math.max(200, Math.floor(env.RUN_LEASE_MS / 3)));
    heartbeat.unref?.();

    try {
      const outcome = await this.search(run, controller.signal, beat);
      await chain;
      await store.finishRun(run.id, workerId, outcome);
      log.info({ outcome }, 'Planning run finished');
      await this.audit(run.tripId, run.ownerId, 'run.finished', { runId: run.id, outcome });
    } catch (err) {
      await chain;
      await this.settleFailure(run, workerId, controller.signal, err, log);
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
    }
  }

  /** Runs the search and saves its plans. Returns how it ended if it did not fail. */
  private async search(
    run: RunRecord,
    signal: AbortSignal,
    beat: (p: RunProgress) => void,
  ): Promise<'succeeded' | 'superseded' | 'cancelled'> {
    const { store } = this.deps;
    const session = await store.getSession(run.tripId);
    // The trip was deleted, or changed since the run was queued.
    if (!session) return 'cancelled';
    if (inputsHash(session) !== run.inputsHash) return 'superseded';

    const params = RunParams.parse(run.params);
    // The orchestrator coordinates the agents and the deterministic services
    // and returns a result; it never writes to the store. What is saved, and
    // whether it may be, is decided here, under the run's own version and
    // fingerprint checks.
    const result = await this.orchestrator.plan({
      intent: session.intent,
      profile: session.profile,
      constraints: session.constraints,
      classification: session.classification,
      requirements: session.statedRequirements,
      keep: params.keep,
      pinsReleased: params.pinsReleased,
      signal,
      onProgress: (p) => beat({ step: p.step, label: p.label, percent: p.percent }),
    });
    signal.throwIfAborted();

    return this.savePlans(run, result);
  }

  /**
   * Saves plans onto the trip if it still has the inputs they were made for.
   * A concurrent save (an answer, a pin) makes the write fail; the trip is
   * then read again and the check repeated, so plans are never written over
   * someone else's change and never dropped for an unrelated one.
   */
  private async savePlans(run: RunRecord, result: OrchestrationResult): Promise<'succeeded' | 'superseded'> {
    const { store } = this.deps;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const session = await store.getSession(run.tripId);
      if (!session || inputsHash(session) !== run.inputsHash) return 'superseded';
      try {
        await store.updateSession(withPlans(session, result));
        return 'succeeded';
      } catch (err) {
        if (!(err instanceof TripChangedError)) throw err;
      }
    }
    throw new TripChangedError();
  }

  private async settleFailure(
    run: RunRecord,
    workerId: string,
    signal: AbortSignal,
    err: unknown,
    log: Logger,
  ): Promise<void> {
    const { store } = this.deps;
    const reason: unknown = signal.aborted ? signal.reason : err;

    if (reason instanceof RunLeaseLost) {
      // Someone else has the run, or this process is stopping. Saying
      // anything about it here would contradict whoever owns it now.
      log.warn('Planning run lost its lease; leaving it to whoever holds it');
      return;
    }
    if (reason instanceof RunCancelled) {
      await store.finishRun(run.id, workerId, 'cancelled');
      await this.audit(run.tripId, run.ownerId, 'run.finished', { runId: run.id, outcome: 'cancelled' });
      return;
    }
    if (reason instanceof RunTimedOut) {
      await store.finishRun(run.id, workerId, 'failed', {
        code: 'planning_timeout',
        message: 'The search took too long and was stopped. Some providers may be slow right now; try again.',
      });
      log.warn('Planning run timed out');
      return;
    }
    // A bug or an unexpected provider fault. The detail stays in the log; the
    // traveller is told plainly, and told nothing was booked.
    log.error({ err }, 'Planning run failed');
    await store.finishRun(run.id, workerId, 'failed', {
      code: 'planning_failed',
      message: 'Something went wrong while building your plans. Nothing was booked or charged. Please try again.',
    });
    await this.audit(run.tripId, run.ownerId, 'run.finished', { runId: run.id, outcome: 'failed' });
  }

  private async audit(tripId: string, actor: string | null, kind: string, detail: Record<string, unknown>) {
    try {
      await this.deps.store.recordAudit({ tripId, kind, actor: actor ?? 'system', detail });
    } catch (err) {
      // The trail is a record, not a gate: losing a line of it must not fail the search.
      this.deps.logger.warn({ err, kind }, 'Could not record an audit event');
    }
  }
}

/**
 * A trip with a search's outcome on it: the validated plans, the explanation,
 * and the trace of what the agents and services did. A request that could not
 * be met leaves no plans and says why in the explanation.
 */
export function withPlans(session: PlanningSession, result: OrchestrationResult): PlanningSession {
  const now = new Date().toISOString();
  return {
    ...session,
    pendingModification: null,
    stage: result.plans.length > 0 ? 'planned' : 'searching',
    plans: result.plans,
    selectedPlanId: result.plans[0]?.id ?? null,
    lastSearch: result.search ? searchSummaryOf(result.search, now) : null,
    narrative: {
      summary: clip(result.narrative.summary, MAX_SUMMARY),
      plans: Object.fromEntries(Object.entries(result.narrative.plans).map(([id, text]) => [id, clip(text, MAX_PLAN_TEXT)])),
      source: result.narrative.source,
      builtAt: now,
    },
    agentTrace: result.trace,
    providerNotes: dedupeNotes([...session.providerNotes, ...result.notes]),
    decisionLog: [...session.decisionLog, ...(result.search?.decisionLog ?? [])],
    updatedAt: now,
  };
}

/** Provider notes repeat across searches; the traveller only needs each once. */
export function dedupeNotes(notes: ProviderNote[]): ProviderNote[] {
  const seen = new Map<string, ProviderNote>();
  for (const note of notes) seen.set(`${note.provider}|${note.status}|${note.message}`, note);
  return [...seen.values()];
}
