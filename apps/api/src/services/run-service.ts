import { z } from 'zod';
import type { Logger } from 'pino';
import { PlanningOrchestrator, type OrchestrationResult, type PlanningServices } from '@trip/agents';
import type { KeptComponents } from '@trip/engine';
import type { TripLlm } from '@trip/llm';
import type { ProviderRegistry } from '@trip/providers';
import {
  ActivityOffer,
  SelectedHotel,
  TransportOffer,
  dedupeProviderNotes,
  type PlanningRunView,
  type PlanningSession,
  type RunKind,
  type RunProgress,
  Deadline,
} from '@trip/shared';
import type { Env } from '../env.js';
import { ApiError } from '../errors.js';
import {
  activeTraceparent,
  categoryOfError,
  currentCorrelation,
  describeError,
  metrics,
  safeId,
  validTraceparent,
  withCorrelation,
  withSpan,
  type ErrorCategory,
} from '@trip/telemetry';
import { MemoryCounterStore, type CounterStore } from '../infra/counters.js';
import { securityEvent } from '../security/events.js';
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
  /**
   * Where the request that queued this run was in its trace, and its id, so the
   * search (in this process or a worker's) continues the same trace and its log
   * lines carry the same request id. Identifiers only: nothing a person wrote.
   */
  trace: z.object({ traceparent: z.string().max(80).optional(), requestId: z.string().max(64).optional() }).default({}),
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
  /** A keyed tag of where the request came from (never the address), for the per-address allowance. */
  address?: string;
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
  /** Counters shared between API processes; defaults to this process's own. */
  counters?: CounterStore;
  /** The deterministic planning services; the engine unless a test stands in for it. */
  planningServices?: PlanningServices;
}

/** How long a caller is told to wait when the queue is full. */
const BUSY_RETRY_SECONDS = 30;

export class RunService {
  private readonly orchestrator: PlanningOrchestrator;
  private readonly counters: CounterStore;

  constructor(private readonly deps: RunServiceDeps) {
    this.counters = deps.counters ?? new MemoryCounterStore();
    this.orchestrator = new PlanningOrchestrator({
      registry: deps.registry,
      agents: { llm: deps.llm, timeoutMs: deps.env.AGENT_TIMEOUT_MS },
      ...(deps.planningServices ? { services: deps.planningServices } : {}),
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

    const traceparent = validTraceparent(activeTraceparent());
    const requestId = safeId(currentCorrelation().requestId);
    const params: RunParams = RunParams.parse({
      reason: options.reason,
      keep: options.keep ?? {},
      pinsReleased: options.pinsReleased ?? [],
      trace: { ...(traceparent ? { traceparent } : {}), ...(requestId ? { requestId } : {}) },
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

    // Counted once a search really exists: a request that reused a running one,
    // or was turned away, has cost nothing.
    await this.recordAddressUse(actor);
    metrics.runs.inc({ event: 'queued', kind: options.kind });
    this.deps.onQueued?.();
    await this.audit(session.id, actor.userId, 'run.queued', { runId: queued.run.id, kind: options.kind });
    return { run: queued.run, reused: false };
  }

  /**
   * Whether this person may start a search now. Each search calls paid provider
   * APIs and holds a worker, so four things are checked, cheapest first, and
   * none of them queues the request to fail later:
   *
   *  1. the person's daily allowance (in the database, so exact across instances);
   *  2. for an anonymous person, the address's daily allowance: a new anonymous
   *     person is one cookie away, so the address is what bounds them;
   *  3. how many searches the person already has going, across all their trips;
   *  4. how deep the queue is. A full queue turns new searches away at once,
   *     with a time to come back, rather than accepting work it will drop.
   */
  async assertQuota(actor: Actor): Promise<void> {
    const { store, env, logger } = this.deps;
    const limit = actor.isAnonymous ? env.PLAN_RUNS_PER_DAY_ANONYMOUS : env.PLAN_RUNS_PER_DAY_SIGNED_IN;
    const started = await store.countRunsSince(actor.userId, new Date(Date.now() - DAY_MS));
    if (started >= limit) {
      securityEvent(logger, 'quota_exceeded', { userId: actor.userId, ...(actor.address ? { address: actor.address } : {}) }, { quota: 'person_daily' });
      throw ApiError.tooManyRequests(
        'daily_search_limit',
        actor.isAnonymous
          ? `You have used today's ${limit} searches. Sign in to get more, or come back tomorrow.`
          : `You have used today's ${limit} searches. Please come back tomorrow.`,
        { limit },
      );
    }

    if (actor.isAnonymous && actor.address) {
      const used = await this.counters.peek(this.addressKey(actor.address));
      if (used.count >= env.PLAN_RUNS_PER_DAY_PER_ADDRESS) {
        securityEvent(logger, 'quota_exceeded', { userId: actor.userId, address: actor.address }, { quota: 'address_daily' });
        throw ApiError.tooManyRequests(
          'daily_search_limit_address',
          'This connection has started a lot of searches today without signing in. Sign in to keep planning, or come back tomorrow.',
          { retryAfterSeconds: Math.max(1, Math.ceil(used.resetMs / 1000)) },
        );
      }
    }

    if ((await store.countActiveRunsForOwner(actor.userId)) >= env.MAX_ACTIVE_RUNS_PER_USER) {
      throw ApiError.tooManyRequests(
        'too_many_active_searches',
        `You already have ${env.MAX_ACTIVE_RUNS_PER_USER} searches running. Wait for one to finish, or stop one, before starting another.`,
        { limit: env.MAX_ACTIVE_RUNS_PER_USER },
      );
    }

    if ((await store.countQueuedRuns()) >= env.MAX_QUEUED_RUNS) {
      securityEvent(logger, 'overloaded', { userId: actor.userId }, { queued: env.MAX_QUEUED_RUNS });
      throw ApiError.busy(
        'A lot of people are planning trips right now, and every search is taken. Nothing was lost: try again in a little while.',
        BUSY_RETRY_SECONDS,
      );
    }
  }

  private addressKey(address: string): string {
    return `plan:address:${address}`;
  }

  private async recordAddressUse(actor: Actor): Promise<void> {
    if (!actor.isAnonymous || !actor.address) return;
    try {
      await this.counters.hit(this.addressKey(actor.address), DAY_MS);
    } catch (err) {
      this.deps.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Could not count a search against its address');
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
  /**
   * Carries out one run this worker has claimed, as one trace span
   * (`planning.run`) that continues the trace of the request that queued it, with
   * the run's identifiers on every log line written inside it. It never throws.
   */
  async execute(run: RunRecord, workerId: string): Promise<void> {
    const parsed = RunParams.safeParse(run.params);
    const carried = parsed.success ? parsed.data.trace : {};
    const waitMs = run.startedAt ? Math.max(0, Date.parse(run.startedAt) - Date.parse(run.createdAt)) : 0;
    const requestId = safeId(carried.requestId);
    return withCorrelation({ runId: run.id, tripId: run.tripId, ...(requestId ? { requestId } : {}) }, () =>
      withSpan(
        'planning.run',
        { 'planning.kind': run.kind, 'planning.attempt': run.attempts, 'planning.queue_wait_ms': waitMs },
        (span) => this.executeObserved(run, workerId, waitMs, span),
        { kind: 'consumer', parentTraceparent: validTraceparent(carried.traceparent) },
      ),
    );
  }

  private async executeObserved(run: RunRecord, workerId: string, waitMs: number, span: { setAttribute(k: string, v: string | number | boolean): void }): Promise<void> {
    const { store, env, logger } = this.deps;
    const controller = new AbortController();
    const log = logger;
    const startedAt = performance.now();
    // Waiting is counted once, for the first attempt: a retry after a crash did not wait again.
    if (run.attempts <= 1) metrics.runQueueWait.observe({ kind: run.kind }, waitMs / 1000);
    metrics.runs.inc({ event: 'started', kind: run.kind });
    let finished: { outcome: 'succeeded' | 'failed' | 'cancelled' | 'superseded'; category?: ErrorCategory; type?: string } = { outcome: 'failed', category: 'internal_error' };
    const hardStop = setTimeout(() => controller.abort(new RunTimedOut()), env.PLANNING_TIMEOUT_MS);
    // The search's time, divided among its stages by the orchestrator so the
    // providers finish (or are cut off) with time left to check and explain.
    const searchDeadline = Deadline.after(env.PLANNING_TIMEOUT_MS);

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
      const outcome = await this.search(run, controller.signal, beat, searchDeadline);
      await chain;
      await store.finishRun(run.id, workerId, outcome);
      finished = { outcome };
      await this.audit(run.tripId, run.ownerId, 'run.finished', { runId: run.id, outcome });
    } catch (err) {
      await chain;
      finished = await this.settleFailure(run, workerId, controller.signal, err, log);
    } finally {
      clearTimeout(hardStop);
      clearInterval(heartbeat);
      // One line and one set of measurements, whichever way the run ended.
      const planningMs = Math.round(performance.now() - startedAt);
      metrics.runs.inc({ event: finished.outcome, kind: run.kind });
      metrics.runDuration.observe({ kind: run.kind, outcome: finished.outcome }, planningMs / 1000);
      if (finished.category) metrics.errors.inc({ category: finished.category, component: 'planning' });
      span.setAttribute('planning.outcome', finished.outcome);
      span.setAttribute('planning.duration_ms', planningMs);
      if (finished.category) span.setAttribute('error.category', finished.category);
      if (finished.type) span.setAttribute('error.type', finished.type);
      log[finished.outcome === 'failed' ? 'warn' : 'info'](
        {
          operation: 'planning.run',
          outcome: finished.outcome,
          kind: run.kind,
          attempt: run.attempts,
          queueWaitMs: waitMs,
          planningMs,
          ...(finished.category ? { errorCategory: finished.category } : {}),
        },
        'Planning run finished',
      );
    }
  }

  /** Runs the search and saves its plans. Returns how it ended if it did not fail. */
  private async search(
    run: RunRecord,
    signal: AbortSignal,
    beat: (p: RunProgress) => void,
    deadline: Deadline,
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
      deadline,
      maxProviderRequests: this.deps.env.MAX_PROVIDER_REQUESTS_PER_SEARCH,
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
  ): Promise<{ outcome: 'succeeded' | 'failed' | 'cancelled' | 'superseded'; category?: ErrorCategory; type?: string }> {
    const { store } = this.deps;
    const reason: unknown = signal.aborted ? signal.reason : err;

    if (reason instanceof RunLeaseLost) {
      // Someone else has the run, or this process is stopping. Saying
      // anything about it here would contradict whoever owns it now.
      log.warn({ operation: 'planning.lease_lost' }, 'Planning run lost its lease; leaving it to whoever holds it');
      return { outcome: 'cancelled', category: 'cancelled' };
    }
    if (reason instanceof RunCancelled) {
      await store.finishRun(run.id, workerId, 'cancelled');
      await this.audit(run.tripId, run.ownerId, 'run.finished', { runId: run.id, outcome: 'cancelled' });
      return { outcome: 'cancelled' };
    }
    if (reason instanceof RunTimedOut) {
      await store.finishRun(run.id, workerId, 'failed', {
        code: 'planning_timeout',
        message: 'The search took too long and was stopped. Some providers may be slow right now; try again.',
      });
      return { outcome: 'failed', category: 'provider_timeout' };
    }
    // A bug or an unexpected provider fault. What is logged is where and what
    // kind (see `describeError`); the traveller is told plainly, and told
    // nothing was booked.
    log.error({ operation: 'planning.run', ...describeError(err) }, 'Planning run failed');
    await store.finishRun(run.id, workerId, 'failed', {
      code: 'planning_failed',
      message: 'Something went wrong while building your plans. Nothing was booked or charged. Please try again.',
    });
    await this.audit(run.tripId, run.ownerId, 'run.finished', { runId: run.id, outcome: 'failed' });
    const described = describeError(err);
    return { outcome: 'failed', category: categoryOfError(err), type: described.errorType };
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
    providerNotes: dedupeProviderNotes([...session.providerNotes, ...result.notes]),
    decisionLog: [...session.decisionLog, ...(result.search?.decisionLog ?? [])],
    updatedAt: now,
  };
}
