/**
 * Small, dependency-free building blocks for staying up when things around us
 * do not: deadlines that can be split into budgets, retry timing, a circuit
 * breaker, a bounded cache and a way to share one in-flight call.
 *
 * Everything here takes its clock (and its randomness) as an argument, so the
 * tests can run them deterministically without waiting or faking timers, and
 * nothing here knows about providers, HTTP or Redis. The provider policy, the
 * HTTP client, the language-model wrapper and the API's own limits are built
 * from these pieces, so they all behave the same way.
 */

export type Clock = () => number;

// ---------------------------------------------------------------- deadlines

/**
 * A point in time by which something must be finished, that can be narrowed but
 * never widened. A search has one for the whole request; each stage takes a
 * share of what is left, each provider call a share of the stage, so nothing
 * lower down can spend what the level above still needs.
 */
export class Deadline {
  private constructor(
    /** Absolute time, in the clock's milliseconds. `Infinity` means no limit. */
    readonly atMs: number,
    private readonly now: Clock,
  ) {}

  static after(ms: number, now: Clock = Date.now): Deadline {
    return new Deadline(now() + Math.max(0, ms), now);
  }

  static never(now: Clock = Date.now): Deadline {
    return new Deadline(Number.POSITIVE_INFINITY, now);
  }

  remainingMs(): number {
    return Math.max(0, this.atMs - this.now());
  }

  get expired(): boolean {
    return this.remainingMs() <= 0;
  }

  /** No later than this deadline, and no later than `ms` from now. */
  within(ms: number): Deadline {
    return new Deadline(Math.min(this.atMs, this.now() + Math.max(0, ms)), this.now);
  }

  /**
   * A deadline that leaves `reserveMs` of what remains for whoever runs after,
   * and is at most `maxMs` from now. A stage that must finish before a later
   * stage needs its time asks for this.
   */
  leaving(reserveMs: number, maxMs: number = Number.POSITIVE_INFINITY): Deadline {
    const usable = Math.max(0, this.remainingMs() - Math.max(0, reserveMs));
    return this.within(Math.min(usable, maxMs));
  }

  /** A fraction of what remains, between `minMs` and `maxMs`, and never past this deadline. */
  share(fraction: number, minMs = 0, maxMs: number = Number.POSITIVE_INFINITY): Deadline {
    const wanted = Math.min(maxMs, Math.max(minMs, this.remainingMs() * Math.min(1, Math.max(0, fraction))));
    return this.within(wanted);
  }
}

/** Why a call was stopped by its own time limit, as opposed to being cancelled. */
export class TimeBudgetExceeded extends Error {
  constructor(readonly limitMs: number) {
    super(`The time allowed for this step (${limitMs} ms) ran out.`);
    this.name = 'TimeBudgetExceeded';
  }
}

export interface TimedSignal {
  signal: AbortSignal;
  /** True if the signal fired because the time ran out, not because the parent was cancelled. */
  timedOut(): boolean;
  /** Releases the timer and the listener. Always call it. */
  dispose(): void;
}

/**
 * A signal that fires when the parent does, or when `ms` have passed. Built on
 * `setTimeout` (not `AbortSignal.timeout`) so it follows fake timers in tests
 * and can be released early, and it says which of the two happened.
 */
export function timedSignal(parent: AbortSignal | undefined, ms: number): TimedSignal {
  const controller = new AbortController();
  let fired = false;
  const onParent = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener('abort', onParent, { once: true });
  }
  const timer = Number.isFinite(ms)
    ? setTimeout(() => {
        if (controller.signal.aborted) return;
        fired = true;
        controller.abort(new TimeBudgetExceeded(ms));
      }, Math.max(0, ms))
    : null;
  timer?.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => fired,
    dispose: () => {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener('abort', onParent);
    },
  };
}

/** Waits `ms`, or less if the signal fires. Resolves true if the whole time was waited. */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ------------------------------------------------------------------ backoff

export interface BackoffOptions {
  /** The delay before the first retry, before jitter. */
  baseMs: number;
  /** No delay is ever longer than this, however many attempts have failed. */
  maxDelayMs: number;
  factor?: number;
}

/**
 * How long to wait before retry number `attempt` (0 for the first retry):
 * exponential, capped, and with "equal jitter" (half fixed, half random), so a
 * crowd of clients that failed together do not all come back together, and no
 * client comes back sooner than half the planned wait.
 */
export function backoffDelayMs(attempt: number, options: BackoffOptions, random: () => number = Math.random): number {
  const factor = options.factor ?? 2;
  const ceiling = Math.min(options.maxDelayMs, options.baseMs * factor ** Math.max(0, attempt));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * Retries are allowed only as a fraction of the requests actually being made,
 * so when a provider is failing everything, retries cannot multiply the load
 * on it. Each request earns `ratio` of a retry; a retry costs one.
 */
export class RetryBudget {
  private tokens: number;

  constructor(
    private readonly options: { ratio: number; initial: number; max: number } = { ratio: 0.2, initial: 10, max: 20 },
  ) {
    this.tokens = options.initial;
  }

  /** Call once for every first attempt. */
  recordRequest(): void {
    this.tokens = Math.min(this.options.max, this.tokens + this.options.ratio);
  }

  /** True, and spends a retry, if one is available. */
  tryAcquire(): boolean {
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  get available(): number {
    return Math.floor(this.tokens);
  }
}

// ---------------------------------------------------------- circuit breaker

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** How long it stays open before one probe is allowed. */
  recoveryTimeoutMs: number;
  /** Probes allowed at once while half open. Default 1. */
  halfOpenMaxCalls?: number;
  now?: Clock;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

/** Permission to make one call; the holder reports how it went. Exactly one of the three methods, once. */
export interface CircuitPermit {
  /** True if this call is the trial that decides whether to close the circuit again. */
  readonly probe: boolean;
  success(): void;
  failure(): void;
  /** The call says nothing about the provider's health (cancelled, bad request); free the slot. */
  ignore(): void;
}

export type CircuitDecision = { allowed: true; permit: CircuitPermit } | { allowed: false; retryAfterMs: number };

/**
 * CLOSED: calls go through and consecutive failures are counted.
 * OPEN: calls are refused, without being made, until the recovery timeout passes.
 * HALF_OPEN: a limited number of probe calls are let through; one success closes
 * the circuit, one failure opens it again for another full timeout.
 */
export class CircuitBreaker {
  private current: CircuitState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private probesInFlight = 0;
  private readonly now: Clock;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? Date.now;
  }

  /** The state, with an elapsed recovery timeout already taken into account. */
  get state(): CircuitState {
    if (this.current === 'open' && this.now() - this.openedAt >= this.options.recoveryTimeoutMs) {
      this.transition('half_open');
    }
    return this.current;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  tryAcquire(): CircuitDecision {
    const state = this.state;
    if (state === 'open') {
      return { allowed: false, retryAfterMs: Math.max(0, this.options.recoveryTimeoutMs - (this.now() - this.openedAt)) };
    }
    if (state === 'half_open') {
      const max = this.options.halfOpenMaxCalls ?? 1;
      if (this.probesInFlight >= max) {
        return { allowed: false, retryAfterMs: Math.max(1000, Math.round(this.options.recoveryTimeoutMs / 4)) };
      }
      this.probesInFlight += 1;
      return { allowed: true, permit: this.permit(true) };
    }
    return { allowed: true, permit: this.permit(false) };
  }

  private permit(probe: boolean): CircuitPermit {
    let settled = false;
    const once = (fn: () => void) => () => {
      if (settled) return;
      settled = true;
      if (probe && this.probesInFlight > 0) this.probesInFlight -= 1;
      fn();
    };
    return {
      probe,
      success: once(() => {
        this.failures = 0;
        if (probe && this.current === 'half_open') this.transition('closed');
      }),
      failure: once(() => {
        if (probe) {
          if (this.current === 'half_open') this.trip();
          return;
        }
        this.failures += 1;
        if (this.current === 'closed' && this.failures >= this.options.failureThreshold) this.trip();
      }),
      ignore: once(() => undefined),
    };
  }

  /** Opens the circuit at once, for a provider that has said when to come back (a rate limit). */
  trip(recoveryTimeoutMs?: number): void {
    this.openedAt = this.now() - (recoveryTimeoutMs === undefined ? 0 : this.options.recoveryTimeoutMs - recoveryTimeoutMs);
    this.probesInFlight = 0;
    this.transition('open');
  }

  private transition(to: CircuitState): void {
    if (this.current === to) return;
    const from = this.current;
    this.current = to;
    if (to === 'closed') this.failures = 0;
    this.options.onStateChange?.(from, to);
  }
}

/** One breaker per key (a provider and a capability), created on first use. */
export class CircuitRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly make: (key: string) => CircuitBreaker) {}

  get(key: string): CircuitBreaker {
    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = this.make(key);
      this.breakers.set(key, breaker);
    }
    return breaker;
  }

  snapshot(): Array<{ key: string; state: CircuitState; consecutiveFailures: number }> {
    return [...this.breakers].map(([key, b]) => ({ key, state: b.state, consecutiveFailures: b.consecutiveFailures }));
  }
}

// -------------------------------------------------------------------- cache

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * A cache with a time to live on every entry and a ceiling on how many it
 * holds (the entry that has gone longest without being written is dropped
 * first). It never returns an expired entry.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(
    private readonly options: { maxEntries: number; now?: Clock },
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    if (this.entries.size > this.options.maxEntries) {
      this.prune();
      while (this.entries.size > this.options.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }
}

/**
 * The shape a shared cache has, whatever holds it (this process, Redis). A
 * value must survive JSON, and a store that cannot be reached answers "not
 * there" and drops writes: a cache is only ever a speed-up.
 */
export interface AsyncCache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
}

export class MemoryCache implements AsyncCache {
  private readonly cache: TtlCache<string>;

  constructor(options: { maxEntries?: number; now?: Clock } = {}) {
    this.cache = new TtlCache<string>({ maxEntries: options.maxEntries ?? 500, ...(options.now ? { now: options.now } : {}) });
  }

  async get(key: string): Promise<unknown | undefined> {
    const raw = this.cache.get(key);
    // Stored as JSON so a caller can never mutate what the cache holds, and
    // so this behaves exactly like a store on the other side of a network.
    return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
  }

  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    this.cache.set(key, JSON.stringify(value), ttlMs);
  }
}

// ------------------------------------------------------------ single flight

/** Callers asking for the same thing at the same time share one call. */
export class SingleFlight<T> {
  private readonly inflight = new Map<string, Promise<T>>();

  run(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const started = work().finally(() => {
      if (this.inflight.get(key) === started) this.inflight.delete(key);
    });
    this.inflight.set(key, started);
    return started;
  }
}
