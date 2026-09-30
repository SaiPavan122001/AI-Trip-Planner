import type { AsyncCache } from '@trip/shared';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Env } from '../env.js';
import { MemoryCounterStore, RedisCounterStore, ResilientCounterStore, type CounterStore, type RedisLike } from './counters.js';

/**
 * Redis, when it is configured: the shared counters behind the rate limits and
 * the shared cache behind the provider lookups. Neither is ever the source of
 * truth for anything (trips, runs and sessions live in PostgreSQL), so Redis
 * being away costs speed and exactness of per-process limits, never data.
 */

export interface SharedInfrastructure {
  counters: CounterStore;
  /** Null when Redis is not configured: providers then use their own in-process cache. */
  cache: AsyncCache | null;
  /** True if REDIS_URL is set. Whether it is answering is discovered per request, and logged when it is not. */
  redisConfigured: boolean;
  /**
   * How Redis is doing, for readiness and the operator's status view:
   * `not_configured` (per-process counters by choice), `ok`, or `degraded` (configured but
   * failing right now, so counters are per process). Never a reason to stop serving.
   */
  redisState(): 'not_configured' | 'ok' | 'degraded';
  close(): Promise<void>;
}

/** A cache in Redis. A value that cannot be read, or a store that cannot be reached, is a miss. */
export class RedisCache implements AsyncCache {
  constructor(
    private readonly redis: RedisLike,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {}

  async get(key: string): Promise<unknown | undefined> {
    try {
      const raw = await this.redis.get(key);
      return raw === null ? undefined : (JSON.parse(raw) as unknown);
    } catch (err) {
      this.onError(err);
      return undefined;
    }
  }

  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'PX', Math.max(1, Math.round(ttlMs)));
    } catch (err) {
      this.onError(err);
    }
  }
}

export function buildInfrastructure(env: Env, logger: Logger, overrides: { redis?: RedisLike } = {}): SharedInfrastructure {
  const local = new MemoryCounterStore();
  const client: RedisLike | null =
    overrides.redis ??
    (env.REDIS_URL
      ? (new Redis(env.REDIS_URL, {
          // A request must not hang on Redis: fail fast and let the fallback count.
          lazyConnect: false,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          connectTimeout: 2_000,
          commandTimeout: 1_000,
          retryStrategy: (attempt) => Math.min(attempt * 500, 5_000),
        }) as unknown as RedisLike)
      : null);

  if (!client) {
    logger.info('REDIS_URL is not set: rate limits and the provider cache are per process.');
    return { counters: local, cache: null, redisConfigured: false, redisState: () => 'not_configured', close: async () => undefined };
  }

  // ioredis reports connection trouble as events; without a listener it throws.
  let lastCacheFailure = 0;
  const cacheFailedRecently = () => lastCacheFailure > 0 && Date.now() - lastCacheFailure < 60_000;
  const emitter = client as unknown as { on?: (event: string, fn: (err: Error) => void) => void };
  let lastLogged = 0;
  const logOnce = (err: unknown) => {
    if (Date.now() - lastLogged < 60_000) return;
    lastLogged = Date.now();
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Redis is not answering: limits and the cache fall back to this process');
  };
  emitter.on?.('error', logOnce);

  const counters = new ResilientCounterStore(new RedisCounterStore(client), local, (e) =>
    logger.warn({ reason: e.reason }, 'Rate limits are being counted in this process only, because Redis is not answering'),
  );
  return {
    counters,
    cache: new RedisCache(client, (err) => {
      lastCacheFailure = Date.now();
      logOnce(err);
    }),
    redisConfigured: true,
    redisState: () => (counters.degraded() || cacheFailedRecently() ? 'degraded' : 'ok'),
    close: async () => {
      await client.quit().catch(() => undefined);
    },
  };
}
