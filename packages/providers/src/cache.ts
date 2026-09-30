import { createHash } from 'node:crypto';
import { metrics } from '@trip/telemetry';
import { z } from 'zod';
import {
  ActivityOffer,
  Place,
  SingleFlight,
  isOk,
  type AsyncCache,
  type Coordinates,
  type ProviderOk,
  type ProviderResult,
} from '@trip/shared';
import type {
  ActivityProvider,
  ActivitySearchRequest,
  GeocodingProvider,
  RouteRequest,
  RouteResult,
  RoutingProvider,
} from './types.js';

/**
 * Caching for the provider answers that are safe to keep.
 *
 * Safe means: the answer does not depend on who asked, and changes slowly.
 * Place names resolving to coordinates, road distances between two points, and
 * what is near a destination are like that. Nothing else is cached:
 *
 *  - Not flight, hotel, rail or bus results: prices and seats change by the
 *    minute and an offer's re-pricing token has a life of its own.
 *  - Not plans, trips, or anything about a person: there is no key that could
 *    leak one traveller's data to another, because none is ever stored.
 *  - Not failures, and not "nothing found": a provider that is down must be
 *    asked again, not remembered as down.
 *
 * Every key names the adapter, the operation and every parameter the answer
 * depends on, under a version prefix that is bumped when a cached shape
 * changes. Every value read back is checked against the same schema as a
 * fresh answer would be, so a stale or tampered entry is a miss, never data.
 * Entries expire (each kind has its own time to live) and the store is
 * bounded; a store that cannot be reached is a miss.
 *
 * The cached answer keeps its original provenance, so the retrieval time the
 * traveller sees is when the provider really said it.
 */

export interface CacheTtls {
  geocodingMs: number;
  routingMs: number;
  activitiesMs: number;
}

export const DEFAULT_CACHE_TTLS: CacheTtls = {
  geocodingMs: 24 * 60 * 60 * 1000,
  routingMs: 6 * 60 * 60 * 1000,
  activitiesMs: 6 * 60 * 60 * 1000,
};

/** Bump when the shape of a cached value changes; old entries then simply are not found. */
const NAMESPACE = 'wf:v1';

export interface CacheEvent {
  type: 'hit' | 'miss' | 'store' | 'invalid';
  key: string;
}

export interface ResponseCacheOptions {
  store: AsyncCache;
  ttls?: Partial<CacheTtls>;
  onEvent?: (event: CacheEvent) => void;
}

/** The parts of a cached lookup that are the same whichever kind of answer it is. */
export class ResponseCache {
  readonly ttls: CacheTtls;
  private readonly flights = new SingleFlight<ProviderResult<unknown>>();

  constructor(private readonly options: ResponseCacheOptions) {
    this.ttls = { ...DEFAULT_CACHE_TTLS, ...options.ttls };
  }

  static keyFor(provider: string, operation: string, params: unknown): string {
    const digest = createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 32);
    return `${NAMESPACE}:${provider}:${operation}:${digest}`;
  }

  /**
   * The cached answer if there is a valid one; otherwise the answer from
   * `fetch`, stored if it succeeded. Callers asking for the same thing at the
   * same time share one call, unless that call was cut short by its own
   * caller's cancellation, in which case each asks for itself.
   */
  async through<T>(
    key: string,
    ttlMs: number,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    fetch: () => Promise<ProviderResult<T>>,
  ): Promise<ProviderResult<T>> {
    const cached = await this.read(key, schema);
    if (cached) return cached;

    let led = false;
    const shared = (await this.flights.run(key, async () => {
      led = true;
      const fresh = await fetch();
      if (isOk(fresh)) await this.write(key, fresh, ttlMs);
      return fresh;
    })) as ProviderResult<T>;
    // A caller that only joined someone else's request does not take on that
    // request's cancellation or budget: it asks for itself.
    if (!led && !isOk(shared) && shared.local) return fetch();
    return shared;
  }

  private async read<T>(key: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<ProviderOk<T> | null> {
    const operation = operationOf(key);
    let raw: unknown;
    try {
      raw = await this.options.store.get(key);
    } catch {
      metrics.cacheEvents.inc({ operation, event: 'error' });
      return null;
    }
    if (raw === undefined || raw === null) {
      metrics.cacheEvents.inc({ operation, event: 'miss' });
      this.options.onEvent?.({ type: 'miss', key });
      return null;
    }
    const parsed = z
      .object({ data: z.unknown(), provenance: z.object({ provider: z.string(), providerLabel: z.string(), retrievedAt: z.string() }).passthrough(), warnings: z.array(z.string()) })
      .safeParse(raw);
    const data = parsed.success ? schema.safeParse(parsed.data.data) : null;
    if (!parsed.success || !data?.success) {
      metrics.cacheEvents.inc({ operation, event: 'invalid' });
      this.options.onEvent?.({ type: 'invalid', key });
      return null;
    }
    metrics.cacheEvents.inc({ operation, event: 'hit' });
    this.options.onEvent?.({ type: 'hit', key });
    return { status: 'ok', data: data.data, provenance: parsed.data.provenance as ProviderOk<T>['provenance'], warnings: parsed.data.warnings };
  }

  private async write<T>(key: string, result: ProviderOk<T>, ttlMs: number): Promise<void> {
    try {
      await this.options.store.set(key, { data: result.data, provenance: result.provenance, warnings: result.warnings }, ttlMs);
      metrics.cacheEvents.inc({ operation: operationOf(key), event: 'store' });
      this.options.onEvent?.({ type: 'store', key });
    } catch {
      metrics.cacheEvents.inc({ operation: operationOf(key), event: 'error' });
      // A cache that cannot be written to is a cache that does not help, not a failure.
    }
  }
}

/** The operation part of a cache key (`wf:v1:<provider>:<operation>:<digest>`), which is a safe metric label. */
const operationOf = (key: string): string => key.split(':')[3] ?? 'unknown';

const round = (n: number, places = 4) => Number(n.toFixed(places));
const rounded = (c: Coordinates) => ({ lat: round(c.lat), lon: round(c.lon) });

// ------------------------------------------------------------------ decorators
//
// Each wraps a provider and answers the same interface, so nothing that uses a
// provider needs to know a cache is there, and the registry's policy still
// wraps the outside (deadline, circuit breaker) exactly as before.

const PlaceList = z.array(Place);

export class CachedGeocodingProvider implements GeocodingProvider {
  constructor(private readonly inner: GeocodingProvider, private readonly cache: ResponseCache) {}

  get descriptor() {
    return this.inner.descriptor;
  }
  isConfigured() {
    return this.inner.isConfigured();
  }
  health() {
    return this.inner.health();
  }

  resolvePlace(query: string, opts?: { limit?: number }) {
    const key = ResponseCache.keyFor(this.inner.descriptor.id, 'resolvePlace', {
      q: query.trim().replace(/\s+/g, ' ').toLowerCase(),
      limit: opts?.limit ?? null,
    });
    return this.cache.through(key, this.cache.ttls.geocodingMs, PlaceList, () => this.inner.resolvePlace(query, opts));
  }

  reverse(coords: Coordinates) {
    const key = ResponseCache.keyFor(this.inner.descriptor.id, 'reverse', rounded(coords));
    return this.cache.through(key, this.cache.ttls.geocodingMs, Place, () => this.inner.reverse(coords));
  }
}

const RouteResultSchema: z.ZodType<RouteResult> = z.object({
  distanceKm: z.number().nonnegative(),
  durationMinutes: z.number().nonnegative(),
  geometry: z.string().nullable(),
});

export class CachedRoutingProvider implements RoutingProvider {
  constructor(private readonly inner: RoutingProvider, private readonly cache: ResponseCache) {}

  get descriptor() {
    return this.inner.descriptor;
  }
  isConfigured() {
    return this.inner.isConfigured();
  }
  health() {
    return this.inner.health();
  }

  route(req: RouteRequest) {
    // A traffic-aware answer depends on when the drive starts, so the departure
    // is part of the key, to the half hour; without one it is not.
    const departBucket = req.departAt ? Math.floor(Date.parse(req.departAt) / (30 * 60_000)) : null;
    const key = ResponseCache.keyFor(this.inner.descriptor.id, 'route', {
      from: rounded(req.from),
      to: rounded(req.to),
      profile: req.profile,
      departBucket: Number.isFinite(departBucket) ? departBucket : null,
    });
    return this.cache.through(key, this.cache.ttls.routingMs, RouteResultSchema, () => this.inner.route(req));
  }
}

const ActivityList = z.array(ActivityOffer);

export class CachedActivityProvider implements ActivityProvider {
  constructor(private readonly inner: ActivityProvider, private readonly cache: ResponseCache) {}

  get descriptor() {
    return this.inner.descriptor;
  }
  isConfigured() {
    return this.inner.isConfigured();
  }
  health() {
    return this.inner.health();
  }

  searchActivities(req: ActivitySearchRequest) {
    const key = ResponseCache.keyFor(this.inner.descriptor.id, 'searchActivities', {
      destination: req.destination.id,
      near: rounded(req.near),
      radiusKm: req.radiusKm,
      categories: [...req.categories].sort(),
      accessibilityNeeds: [...req.accessibilityNeeds].sort(),
      currency: req.currency,
      limit: req.limit,
    });
    return this.cache.through(key, this.cache.ttls.activitiesMs, ActivityList, () => this.inner.searchActivities(req));
  }
}
