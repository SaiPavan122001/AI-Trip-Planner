import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { metrics } from '@trip/telemetry';
import type { Env } from '../env.js';
import type { Store } from '../repository/store.js';
import type { RunService } from '../services/run-service.js';

/**
 * Takes background searches off the queue and runs them.
 *
 * It can live inside the API process (the default, so a single `npm run dev`
 * works) or in its own process (`RUN_WORKER=false` on the API and a separate
 * `worker` process); it is the same code either way, and any number of workers
 * may run at once, because taking a run is a single atomic step in the store.
 */
export class RunWorker {
  readonly id = `worker-${randomUUID().slice(0, 8)}`;
  private readonly inflight = new Set<Promise<void>>();
  private stopping = false;
  private loop: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;
  private lastMaintenance = 0;

  constructor(
    private readonly deps: { store: Store; runs: RunService; env: Env; logger: Logger },
  ) {}

  start(): void {
    if (this.loop) return;
    this.deps.logger.info({ workerId: this.id, concurrency: this.deps.env.RUN_CONCURRENCY }, 'Planning worker started');
    this.loop = this.run();
  }

  /** Makes the worker look for work now instead of at its next poll. */
  wake(): void {
    this.wakeUp?.();
  }

  /**
   * Stops taking new runs and waits, up to `graceMs`, for the ones in
   * progress. A run still going after that is left to its lease: it lapses
   * and another worker takes it up.
   */
  async stop(graceMs = 25_000): Promise<void> {
    this.stopping = true;
    this.wake();
    await this.loop;
    const finished = Promise.allSettled([...this.inflight]);
    await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, graceMs).unref?.())]);
    this.deps.logger.info({ workerId: this.id, unfinished: this.inflight.size }, 'Planning worker stopped');
  }

  /** Claims and runs everything queued, one after another. For tests and one-off scripts. */
  async drain(): Promise<number> {
    const { store, runs, env } = this.deps;
    await store.reapRuns(env.RUN_MAX_ATTEMPTS);
    await store.expireStaleQueued(env.RUN_QUEUE_TIMEOUT_MS);
    let done = 0;
    for (;;) {
      const run = await store.claimRun(this.id, env.RUN_LEASE_MS, env.RUN_MAX_ATTEMPTS);
      if (!run) return done;
      await runs.execute(run, this.id);
      done += 1;
    }
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.tick();
        await this.maintain();
      } catch (err) {
        // A store outage must not kill the worker; it retries at the next poll.
        this.deps.logger.error({ err }, 'Planning worker could not poll for work');
      }
      await this.sleep(this.deps.env.RUN_POLL_MS);
    }
  }

  private async tick(): Promise<void> {
    const { store, runs, env, logger } = this.deps;
    await store.reapRuns(env.RUN_MAX_ATTEMPTS);
    // A backlog is shed, not served after the people who asked have gone.
    const dropped = await store.expireStaleQueued(env.RUN_QUEUE_TIMEOUT_MS);
    if (dropped > 0) {
      metrics.runs.inc({ event: 'expired' }, dropped);
      logger.warn({ operation: 'planning.queue_expiry', dropped }, 'Dropped searches that waited too long for a worker');
    }
    while (!this.stopping && this.inflight.size < env.RUN_CONCURRENCY) {
      const run = await store.claimRun(this.id, env.RUN_LEASE_MS, env.RUN_MAX_ATTEMPTS);
      if (!run) return;
      logger.info({ runId: run.id, tripId: run.tripId, attempt: run.attempts }, 'Planning run started');
      const task: Promise<void> = runs
        .execute(run, this.id)
        .catch((err: unknown) => logger.error({ err, runId: run.id }, 'Planning run crashed the executor'))
        .finally(() => {
          this.inflight.delete(task);
          // A slot is free: look for more work straight away.
          this.wake();
        });
      this.inflight.add(task);
    }
  }

  /** Housekeeping, at most every ten minutes: removes what has expired. */
  private async maintain(): Promise<void> {
    const now = Date.now();
    if (now - this.lastMaintenance < 10 * 60_000) return;
    this.lastMaintenance = now;
    const swept = await this.deps.store.sweepExpired(new Date(now));
    if (Object.values(swept).some((n) => n > 0)) this.deps.logger.info({ swept }, 'Removed expired records');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wakeUp = () => {
        clearTimeout(timer);
        this.wakeUp = null;
        resolve();
      };
    });
  }
}
