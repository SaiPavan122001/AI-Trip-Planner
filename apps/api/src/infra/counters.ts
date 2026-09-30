/**
 * Counters shared by every API process, for the limits that must hold however
 * many instances are running.
 *
 * A limit that lives in one process's memory is multiplied by the number of
 * processes, and forgotten on every restart. The counters here live in Redis
 * when it is configured, so all instances count into the same number. When
 * Redis is not configured, or cannot be reached, they fall back to this
 * process's own memory: the limit still applies (per process, and the log says
 * so), it does not silently switch off. Failing open on a Redis outage would
 * turn "the cache is down" into "anyone may run unlimited paid searches".
 */

import { metrics } from '@trip/telemetry';

export interface CounterHit {
  /** The count in the current window, including this hit. */
  count: number;
  /** Milliseconds until the window ends and the count starts again. */
  resetMs: number;
}

export interface CounterStore {
  /** Adds one to the counter for `key`, starting a window of `windowMs` if there is none. */
  hit(key: string, windowMs: number): Promise<CounterHit>;
  /** The current count and time left, without counting. Zero if there is no window. */
  peek(key: string): Promise<CounterHit>;
  /** Where the counting happens, for the log and for health checks. */
  readonly kind: 'memory' | 'redis';
}

// ------------------------------------------------------------------- memory

interface Window {
  count: number;
  endsAt: number;
}

/** Fixed windows in this process. Bounded, and swept, so a flood of distinct keys cannot fill memory. */
export class MemoryCounterStore implements CounterStore {
  readonly kind = 'memory' as const;
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly options: { maxKeys?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  async hit(key: string, windowMs: number): Promise<CounterHit> {
    const now = this.now();
    let w = this.windows.get(key);
    if (!w || w.endsAt <= now) {
      this.makeRoom(now);
      w = { count: 0, endsAt: now + windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    return { count: w.count, resetMs: Math.max(0, w.endsAt - now) };
  }

  async peek(key: string): Promise<CounterHit> {
    const now = this.now();
    const w = this.windows.get(key);
    if (!w || w.endsAt <= now) return { count: 0, resetMs: 0 };
    return { count: w.count, resetMs: w.endsAt - now };
  }

  get size(): number {
    return this.windows.size;
  }

  private makeRoom(now: number): void {
    const max = this.options.maxKeys ?? 50_000;
    if (this.windows.size < max) return;
    for (const [key, w] of this.windows) if (w.endsAt <= now) this.windows.delete(key);
    // Still full of live windows: drop the oldest. An attacker can make this
    // forget other callers' counts, but only by flooding distinct keys, which
    // the address-level limits bound first.
    while (this.windows.size >= max) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }
}

// -------------------------------------------------------------------- redis

/** The parts of a Redis client this uses, so a test can stand in for one and no live server is needed. */
export interface RedisLike {
  multi(): RedisPipeline;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  pttl(key: string): Promise<number>;
  quit(): Promise<unknown>;
  ping(): Promise<string>;
}

export interface RedisPipeline {
  set(key: string, value: string, ...args: Array<string | number>): RedisPipeline;
  incr(key: string): RedisPipeline;
  pttl(key: string): RedisPipeline;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

/**
 * A fixed window per key, kept in Redis. The window is created and counted in
 * one transaction (`SET key 0 PX window NX`, `INCR`, `PTTL`), so two instances
 * hitting the same key at the same moment cannot both start a window, and a
 * crash between the steps cannot leave a counter with no expiry.
 */
export class RedisCounterStore implements CounterStore {
  readonly kind = 'redis' as const;

  constructor(
    private readonly redis: RedisLike,
    private readonly prefix = 'wf:rl:',
  ) {}

  async hit(key: string, windowMs: number): Promise<CounterHit> {
    const k = this.prefix + key;
    const replies = await this.redis.multi().set(k, '0', 'PX', windowMs, 'NX').incr(k).pttl(k).exec();
    if (!replies) throw new Error('Redis transaction was discarded');
    for (const [err] of replies) if (err) throw err;
    const count = Number(replies[1]![1]);
    const ttl = Number(replies[2]![1]);
    if (!Number.isFinite(count)) throw new Error('Redis returned an unusable counter');
    // A key that somehow has no expiry is given one, so it cannot count forever.
    if (ttl < 0) await this.redis.set(k, String(count), 'PX', windowMs);
    return { count, resetMs: ttl < 0 ? windowMs : ttl };
  }

  async peek(key: string): Promise<CounterHit> {
    const k = this.prefix + key;
    const raw = await this.redis.get(k);
    if (raw === null) return { count: 0, resetMs: 0 };
    const ttl = await this.redis.pttl(k);
    return { count: Number(raw) || 0, resetMs: Math.max(0, ttl) };
  }
}

// ----------------------------------------------------------------- fallback

export interface DegradedEvent {
  /** What went wrong, safe to log. */
  reason: string;
}

/**
 * Uses the shared store, and this process's own if the shared one fails. A
 * Redis error is logged (once a minute, not once a request) and the request is
 * still counted, in memory, so the limit is applied per process for as long as
 * Redis is away.
 */
export class ResilientCounterStore implements CounterStore {
  private lastReport = 0;
  private lastFailureAt = 0;

  constructor(
    private readonly shared: CounterStore,
    private readonly local: CounterStore,
    private readonly onDegraded: (event: DegradedEvent) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  get kind(): 'memory' | 'redis' {
    return this.shared.kind;
  }

  /** True if the shared store failed within the last `withinMs` (default a minute): it is not being relied on right now. */
  degraded(withinMs = 60_000): boolean {
    return this.lastFailureAt > 0 && this.now() - this.lastFailureAt < withinMs;
  }

  async hit(key: string, windowMs: number): Promise<CounterHit> {
    try {
      return await this.shared.hit(key, windowMs);
    } catch (err) {
      this.report(err);
      return this.local.hit(key, windowMs);
    }
  }

  async peek(key: string): Promise<CounterHit> {
    try {
      return await this.shared.peek(key);
    } catch (err) {
      this.report(err);
      return this.local.peek(key);
    }
  }

  private report(err: unknown): void {
    const t = this.now();
    this.lastFailureAt = t;
    metrics.errors.inc({ category: 'dependency_unavailable', component: 'redis' });
    if (t - this.lastReport < 60_000) return;
    this.lastReport = t;
    this.onDegraded({ reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown error' });
  }
}
