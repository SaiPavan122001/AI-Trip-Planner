import { describe, expect, it } from 'vitest';
import { MemoryCounterStore, RedisCounterStore, ResilientCounterStore, type CounterStore, type RedisLike, type RedisPipeline } from '../infra/counters.js';
import { RedisCache, buildInfrastructure, type SharedInfrastructure } from '../infra/redis.js';
import pino from 'pino';
import { RateLimiter, buildPolicies, parseDuration } from '../security/rate-limit.js';
import { addressPrefix, addressTag } from '../security/events.js';
import { TRIP_ID, buildTestApp, signedInUser, testEnv } from './helpers.js';
import { newTripBody, cookieFrom } from './test-kit.js';

/**
 * Rate limiting and abuse protection (Phase 5.4, 6.12).
 *
 * The thing to be sure of is that a limit cannot be walked around by changing
 * the one thing a caller controls for free (a cookie), that it holds however
 * many instances run, and that an outage of the shared store makes the limits
 * per-process, never absent.
 */

const infraWith = (counters: CounterStore): SharedInfrastructure => ({ counters, cache: null, redisConfigured: false, redisState: () => 'not_configured', close: async () => undefined });
const clock = () => {
  let t = 1_700_000_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

const ADDR_A = '203.0.113.10';
const ADDR_B = '203.0.113.11';

// ---------------------------------------------------------------- the store

/** Enough of Redis to run the counter's own transaction: SET NX PX, INCR, PTTL, GET, expiry. */
function fakeRedis(options: { now?: () => number } = {}): RedisLike & { failing: boolean; keys: () => string[] } {
  const now = options.now ?? Date.now;
  const data = new Map<string, { value: string; expiresAt: number | null }>();
  const live = (key: string) => {
    const entry = data.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= now()) data.delete(key);
    return data.get(key);
  };
  const state = { failing: false };
  const check = () => {
    if (state.failing) throw new Error('ECONNREFUSED 127.0.0.1:6379');
  };
  const set = (key: string, value: string, ...args: Array<string | number>) => {
    const px = args.indexOf('PX');
    const nx = args.includes('NX');
    if (nx && live(key)) return null;
    data.set(key, { value, expiresAt: px >= 0 ? now() + Number(args[px + 1]) : null });
    return 'OK';
  };
  const incr = (key: string) => {
    const entry = live(key);
    if (!entry) {
      data.set(key, { value: '1', expiresAt: null });
      return 1;
    }
    entry.value = String(Number(entry.value) + 1);
    return Number(entry.value);
  };
  const pttl = (key: string) => {
    const entry = live(key);
    if (!entry) return -2;
    return entry.expiresAt === null ? -1 : entry.expiresAt - now();
  };
  return {
    get failing() {
      return state.failing;
    },
    set failing(v: boolean) {
      state.failing = v;
    },
    keys: () => [...data.keys()],
    multi(): RedisPipeline {
      const steps: Array<() => unknown> = [];
      const pipeline: RedisPipeline = {
        set: (key, value, ...args) => (steps.push(() => set(key, value, ...args)), pipeline),
        incr: (key) => (steps.push(() => incr(key)), pipeline),
        pttl: (key) => (steps.push(() => pttl(key)), pipeline),
        exec: async () => {
          check();
          return steps.map((step) => [null, step()] as [Error | null, unknown]);
        },
      };
      return pipeline;
    },
    async get(key) {
      check();
      return live(key)?.value ?? null;
    },
    async set(key, value, ...args) {
      check();
      return set(key, value, ...args);
    },
    async pttl(key) {
      check();
      return pttl(key);
    },
    async quit() {
      return 'OK';
    },
    async ping() {
      check();
      return 'PONG';
    },
  };
}

describe('the counters', () => {
  it('count within a window and start again after it', async () => {
    const c = clock();
    const store = new MemoryCounterStore({ now: c.now });
    expect((await store.hit('k', 1000)).count).toBe(1);
    expect((await store.hit('k', 1000)).count).toBe(2);
    expect(await store.peek('k')).toEqual({ count: 2, resetMs: 1000 });
    c.advance(1001);
    expect((await store.hit('k', 1000)).count).toBe(1);
    expect(await store.peek('nobody')).toEqual({ count: 0, resetMs: 0 });
  });

  it('are bounded: a flood of distinct keys cannot fill memory', async () => {
    const store = new MemoryCounterStore({ maxKeys: 100 });
    for (let i = 0; i < 1_000; i += 1) await store.hit(`attacker-${i}`, 60_000);
    expect(store.size).toBeLessThanOrEqual(100);
  });

  it('are shared through Redis, in one transaction that starts the window and counts', async () => {
    const c = clock();
    const redis = fakeRedis({ now: c.now });
    const a = new RedisCounterStore(redis);
    const b = new RedisCounterStore(redis); // another instance, the same Redis
    expect((await a.hit('plan:user:1', 60_000)).count).toBe(1);
    expect((await b.hit('plan:user:1', 60_000)).count).toBe(2);
    expect((await a.hit('plan:user:1', 60_000)).count).toBe(3);
    expect((await b.peek('plan:user:1')).count).toBe(3);
    c.advance(60_001);
    expect((await b.hit('plan:user:1', 60_000)).count).toBe(1);
  });

  it('give a key that somehow has no expiry one, so it cannot count forever', async () => {
    const redis = fakeRedis();
    await redis.set('wf:rl:stuck', '5'); // no PX
    const store = new RedisCounterStore(redis);
    const hit = await store.hit('stuck', 5_000);
    expect(hit.count).toBe(6);
    expect((await redis.pttl('wf:rl:stuck'))).toBeGreaterThan(0);
  });

  it('fall back to this process when Redis fails, so the limit still applies, and report it once', async () => {
    const redis = fakeRedis();
    const reports: string[] = [];
    const store = new ResilientCounterStore(new RedisCounterStore(redis), new MemoryCounterStore(), (e) => reports.push(e.reason));
    expect((await store.hit('k', 60_000)).count).toBe(1);
    redis.failing = true;
    // The failure is absorbed and the request is still counted, in memory.
    expect((await store.hit('k', 60_000)).count).toBe(1);
    expect((await store.hit('k', 60_000)).count).toBe(2);
    expect(reports).toHaveLength(1); // once, not once a request
    expect(reports[0]).toMatch(/ECONNREFUSED/);
    redis.failing = false;
    expect((await store.hit('k', 60_000)).count).toBe(2); // Redis again (it had one hit before)
  });

  it('a cache in Redis treats every failure as a miss and never throws', async () => {
    const redis = fakeRedis();
    const errors: unknown[] = [];
    const cache = new RedisCache(redis, (e) => errors.push(e));
    await cache.set('k', { a: 1 }, 1000);
    expect(await cache.get('k')).toEqual({ a: 1 });
    redis.failing = true;
    expect(await cache.get('k')).toBeUndefined();
    await expect(cache.set('k2', 1, 1000)).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    // An entry that is not JSON is a miss too.
    redis.failing = false;
    await redis.set('bad', '{not json');
    expect(await cache.get('bad')).toBeUndefined();
  });
});

describe('addresses', () => {
  it('are never stored: only a keyed tag, stable for one address and different between keys', () => {
    const tag = addressTag('secret-one-secret-one-secret-one!', ADDR_A);
    expect(tag).toMatch(/^[0-9a-f]{16}$/);
    expect(tag).not.toContain('203');
    expect(addressTag('secret-one-secret-one-secret-one!', ADDR_A)).toBe(tag);
    expect(addressTag('secret-two-secret-two-secret-two!', ADDR_A)).not.toBe(tag);
    expect(addressTag('secret-one-secret-one-secret-one!', ADDR_B)).not.toBe(tag);
  });

  it('treat every address in one IPv6 /64 as one caller, and an IPv4-mapped address as its IPv4', () => {
    expect(addressPrefix('2001:db8:aaaa:bbbb:1:2:3:4')).toBe(addressPrefix('2001:db8:aaaa:bbbb:ffff:ffff:ffff:ffff'));
    expect(addressPrefix('2001:db8:aaaa:bbbb::1')).toBe(addressPrefix('2001:db8:aaaa:bbbb:9::9'));
    expect(addressPrefix('2001:db8:aaaa:cccc::1')).not.toBe(addressPrefix('2001:db8:aaaa:bbbb::1'));
    expect(addressPrefix('::ffff:203.0.113.10')).toBe('203.0.113.10');
    expect(addressPrefix('203.0.113.10')).toBe('203.0.113.10');
  });

  it('parse the duration setting the limits are configured with', () => {
    expect(parseDuration('1 minute')).toBe(60_000);
    expect(parseDuration('30 seconds')).toBe(30_000);
    expect(parseDuration('2 hours')).toBe(7_200_000);
    expect(() => parseDuration('soon')).toThrow();
  });
});

// ------------------------------------------------------------ the limiter

describe('the limiter', () => {
  const policy = { name: 'p', rules: [{ scope: 'user' as const, max: 3, windowMs: 60_000 }, { scope: 'address' as const, max: 5, windowMs: 60_000 }] };

  it('allows up to the limit, then says how long to wait', async () => {
    const c = clock();
    const limiter = new RateLimiter(new MemoryCounterStore({ now: c.now }));
    const caller = { userId: 'u1', address: 'a1' };
    for (let i = 0; i < 3; i += 1) expect((await limiter.consume(policy, caller)).allowed).toBe(true);
    const denied = await limiter.consume(policy, caller);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.retryAfterSeconds).toBe(60);
    c.advance(30_000);
    const still = await limiter.consume(policy, caller);
    if (!still.allowed) expect(still.retryAfterSeconds).toBe(30);
    c.advance(30_001);
    expect((await limiter.consume(policy, caller)).allowed).toBe(true);
  });

  it('counts the address whoever the person is: five different people from one address share its allowance', async () => {
    const limiter = new RateLimiter(new MemoryCounterStore());
    let allowed = 0;
    for (let person = 0; person < 5; person += 1) {
      for (let i = 0; i < 3; i += 1) if ((await limiter.consume(policy, { userId: `u${person}`, address: 'shared' })).allowed) allowed += 1;
    }
    expect(allowed).toBe(5); // each person had room; the address did not
  });

  it('gives someone with no cookie no way round it: only the address is counted, and it is enough', async () => {
    const limiter = new RateLimiter(new MemoryCounterStore());
    let allowed = 0;
    for (let i = 0; i < 20; i += 1) if ((await limiter.consume(policy, { userId: null, address: 'x' })).allowed) allowed += 1;
    expect(allowed).toBe(5);
  });

  it('does not let one address, or one person, use up another\'s allowance', async () => {
    const limiter = new RateLimiter(new MemoryCounterStore());
    for (let i = 0; i < 10; i += 1) await limiter.consume(policy, { userId: 'u1', address: 'a1' });
    expect((await limiter.consume(policy, { userId: 'u2', address: 'a2' })).allowed).toBe(true);
  });

  it('counts a per-minute and a per-day limit on the same address as two counters, not one', async () => {
    // Regression: both rules once shared a key, so each request counted twice against each.
    const c = clock();
    const limiter = new RateLimiter(new MemoryCounterStore({ now: c.now }));
    const both = { name: 'both', rules: [{ scope: 'address' as const, max: 3, windowMs: 60_000 }, { scope: 'address' as const, max: 5, windowMs: 3_600_000 }] };
    const caller = { userId: null, address: 'a' };
    const allowed = async () => (await limiter.consume(both, caller)).allowed;
    expect([await allowed(), await allowed(), await allowed(), await allowed()]).toEqual([true, true, true, false]); // the minute limit, exactly
    c.advance(60_001);
    // A new minute: the hour has seen 4 requests (the refused one counted too), so it has room for 1 more.
    expect(await allowed()).toBe(true);
    expect(await allowed()).toBe(false);
  });

  it('holds across instances that share a store (Redis), exactly', async () => {
    const redis = fakeRedis();
    const one = new RateLimiter(new RedisCounterStore(redis));
    const two = new RateLimiter(new RedisCounterStore(redis));
    const caller = { userId: 'u1', address: 'a1' };
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? one : two).consume(policy, caller)));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });

  it('can tell a caller is locked out without counting them again', async () => {
    const limiter = new RateLimiter(new MemoryCounterStore());
    const failed = { name: 'f', rules: [{ scope: 'address' as const, max: 2, windowMs: 60_000 }] };
    const caller = { userId: null, address: 'a' };
    expect((await limiter.isLocked(failed, caller)).locked).toBe(false);
    await limiter.record(failed, caller);
    expect((await limiter.isLocked(failed, caller)).locked).toBe(false);
    await limiter.record(failed, caller);
    expect((await limiter.isLocked(failed, caller)).locked).toBe(true);
    await limiter.isLocked(failed, caller); // peeking changes nothing
    expect((await limiter.isLocked(failed, caller)).locked).toBe(true);
  });

  it('has an address ceiling above every person ceiling, so a shared connection is not shut out by one member', () => {
    const policies = buildPolicies(testEnv());
    for (const p of Object.values(policies)) {
      const users = p.rules.filter((r) => r.scope === 'user');
      const addresses = p.rules.filter((r) => r.scope === 'address' && r.windowMs === users[0]?.windowMs);
      if (users[0] && addresses[0]) expect(addresses[0].max).toBeGreaterThan(users[0].max);
    }
  });
});

// -------------------------------------------------------------- over HTTP

describe('over HTTP', () => {
  it('turns away with 429, a plain sentence, and how long to wait', async () => {
    const { app } = await buildTestApp({ envVars: { RATE_LIMIT_MAX: '5' } });
    const codes: number[] = [];
    let last: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let i = 0; i < 8; i += 1) {
      last = await app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}`, remoteAddress: ADDR_A });
      codes.push(last.statusCode);
    }
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5)).toEqual([429, 429, 429]);
    expect(last!.headers['retry-after']).toMatch(/^\d+$/);
    expect(last!.json().error).toMatchObject({ code: 'rate_limited' });
    expect(last!.json().error.message).toMatch(/Please wait/);
    expect(JSON.stringify(last!.json())).not.toContain(ADDR_A);
  });

  it('says how much is left on every answer', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}` });
    expect(Number(res.headers['ratelimit-limit'])).toBeGreaterThan(0);
    expect(Number(res.headers['ratelimit-remaining'])).toBeGreaterThanOrEqual(0);
    expect(Number(res.headers['ratelimit-reset'])).toBeGreaterThan(0);
  });

  it('does not limit health probes, which orchestrators call constantly', async () => {
    const { bare } = await buildTestApp({ envVars: { RATE_LIMIT_MAX: '2', RATE_LIMIT_ADDRESS_MAX: '2' } });
    for (let i = 0; i < 20; i += 1) expect((await bare.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('does not get in the way of ordinary use', async () => {
    const { app } = await buildTestApp();
    for (let i = 0; i < 60; i += 1) expect((await app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}` })).statusCode).toBe(200);
  });

  it('answers a burst of simultaneous requests with exactly the allowed number of successes', async () => {
    const { app } = await buildTestApp({ envVars: { RATE_LIMIT_MAX: '1000' } });
    // 'places' allows a person 40 a minute; 100 arrive at once.
    const results = await Promise.all(
      Array.from({ length: 100 }, () => app.inject({ method: 'GET', url: '/v1/places?q=goa', remoteAddress: ADDR_A })),
    );
    const limited = results.filter((r) => r.statusCode === 429).length;
    expect(limited).toBe(60);
    expect(results.filter((r) => r.statusCode !== 429)).toHaveLength(40);
  });

  it('starts counting again when the window ends', async () => {
    const c = clock();
    const { app } = await buildTestApp({ envVars: { RATE_LIMIT_MAX: '2' }, infra: infraWith(new MemoryCounterStore({ now: c.now })) });
    const get = () => app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}`, remoteAddress: ADDR_A });
    expect((await get()).statusCode).toBe(200);
    expect((await get()).statusCode).toBe(200);
    expect((await get()).statusCode).toBe(429);
    c.advance(60_001);
    expect((await get()).statusCode).toBe(200);
  });

  it('holds across two API instances that share their counters (as they would through Redis)', async () => {
    const shared = new MemoryCounterStore();
    const first = await buildTestApp({ envVars: { RATE_LIMIT_MAX: '6' }, infra: infraWith(shared) });
    const second = await buildTestApp({ envVars: { RATE_LIMIT_MAX: '6' }, infra: infraWith(shared), repository: first.repository, seedTrip: false });
    // The same person (their cookie works on both, as the store is shared).
    const codes: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const target = i % 2 ? second : first;
      codes.push((await target.bare.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}`, headers: { cookie: first.owner.cookie } })).statusCode);
    }
    expect(codes.filter((c) => c === 200)).toHaveLength(6);
    expect(codes.filter((c) => c === 429)).toHaveLength(4);
  });

  it('keeps limiting, per process, when the shared store goes down', async () => {
    const redis = fakeRedis();
    const counters = new ResilientCounterStore(new RedisCounterStore(redis), new MemoryCounterStore());
    const { app } = await buildTestApp({ envVars: { RATE_LIMIT_MAX: '4' }, infra: infraWith(counters) });
    redis.failing = true;
    const codes: number[] = [];
    for (let i = 0; i < 7; i += 1) codes.push((await app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}`, remoteAddress: ADDR_A })).statusCode);
    expect(codes.filter((c) => c === 429).length).toBe(3); // not open: the limit applies in this process
    expect(codes.filter((c) => c === 500 || c === 503)).toHaveLength(0); // and nothing failed for the caller
  });
});

describe('through the infrastructure the service starts with', () => {
  const env = () => testEnv({ REDIS_URL: 'redis://redis.example.test:6379' });

  it('uses Redis for the counters and the cache when it is configured, and shares them between instances', async () => {
    const redis = fakeRedis();
    const one = buildInfrastructure(env(), pino({ level: 'silent' }), { redis });
    const two = buildInfrastructure(env(), pino({ level: 'silent' }), { redis });
    expect(one.redisConfigured).toBe(true);
    expect(one.counters.kind).toBe('redis');
    expect((await one.counters.hit('k', 60_000)).count).toBe(1);
    expect((await two.counters.hit('k', 60_000)).count).toBe(2);
    await one.cache!.set('wf:v1:x', { hello: 'world' }, 60_000);
    expect(await two.cache!.get('wf:v1:x')).toEqual({ hello: 'world' });
    expect(redis.keys().some((k) => k.startsWith('wf:rl:'))).toBe(true);
  });

  it('uses this process alone when there is no Redis, and says so', async () => {
    const messages: string[] = [];
    const logger = pino({ level: 'info' }, { write: (line: string) => messages.push(line) });
    const infra = buildInfrastructure(testEnv(), logger);
    expect(infra.redisConfigured).toBe(false);
    expect(infra.counters.kind).toBe('memory');
    expect(infra.cache).toBeNull();
    expect(messages.join('')).toMatch(/per process/);
  });

  it('applies the limits through Redis across two API instances, and keeps applying them if Redis then fails', async () => {
    const redis = fakeRedis();
    const infra = () => buildInfrastructure(env(), pino({ level: 'silent' }), { redis });
    const first = await buildTestApp({ envVars: { RATE_LIMIT_MAX: '6' }, infra: infra() });
    const second = await buildTestApp({ envVars: { RATE_LIMIT_MAX: '6' }, infra: infra(), repository: first.repository, seedTrip: false });
    const get = (t: typeof first) => t.bare.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}`, headers: { cookie: first.owner.cookie } });
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) codes.push((await get(i % 2 ? second : first)).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 200]);
    redis.failing = true; // Redis goes away with one request of the six left
    // With Redis away each process counts for itself, so the two together allow up to twice the limit: 16 requests are 8 each.
    for (let i = 0; i < 16; i += 1) codes.push((await get(i % 2 ? second : first)).statusCode);
    // Nothing failed for the caller, and the limit still bites (each process now counts for itself).
    expect(codes.some((c) => c >= 500)).toBe(false);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });
});

describe('anonymous cookie rotation', () => {
  it('cannot restart the allowance by dropping the cookie: new anonymous people from one address share the address limit', async () => {
    const { repository, bare, ctx } = await buildTestApp({ seedTrip: false });
    // Five different "people", each with a fresh cookie, all from one address.
    const people = await Promise.all(Array.from({ length: 5 }, () => signedInUser(repository, ctx.env)));
    const results = await Promise.all(
      people.flatMap((p) =>
        Array.from({ length: 40 }, () => bare.inject({ method: 'GET', url: '/v1/places?q=goa', remoteAddress: ADDR_A, headers: { cookie: p.cookie } })),
      ),
    );
    // 200 attempts; the address is allowed 120 a minute, however many cookies it shows.
    const accepted = results.filter((r) => r.statusCode !== 429).length;
    expect(accepted).toBe(120);
    // A different address is untouched (a person who has used their own allowance is still held to it, wherever they are).
    const newcomer = await signedInUser(repository, ctx.env);
    const other = await bare.inject({ method: 'GET', url: '/v1/places?q=goa', remoteAddress: ADDR_B, headers: { cookie: newcomer.cookie } });
    expect(other.statusCode).not.toBe(429);
    const sameAsBefore = await bare.inject({ method: 'GET', url: '/v1/places?q=goa', remoteAddress: ADDR_B, headers: { cookie: people[0]!.cookie } });
    expect(sameAsBefore.statusCode).toBe(429);
  });

  it('cannot mint unlimited anonymous people from one address: first trips are counted per address', async () => {
    const { bare } = await buildTestApp({ geocoding: true, seedTrip: false });
    const created: number[] = [];
    for (let i = 0; i < 36; i += 1) {
      const res = await bare.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody, remoteAddress: ADDR_A });
      created.push(res.statusCode);
      if (res.statusCode === 429) expect(cookieFrom(res)).toBeNull(); // no session is handed out to one who is refused
    }
    expect(created.filter((c) => c === 201)).toHaveLength(30);
    expect(created.filter((c) => c === 429).length).toBe(6);
    // Another address can still start.
    expect((await bare.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody, remoteAddress: ADDR_B })).statusCode).toBe(201);
  });

  it('holds the daily search allowance for an address across anonymous people, but leaves signed-in people to their own', async () => {
    const { bare, repository, ctx } = await buildTestApp({ seedTrip: false, envVars: { PLAN_RUNS_PER_DAY_PER_ADDRESS: '2' } });
    const trips = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const person = await signedInUser(repository, ctx.env); // anonymous: no email
        const { sessionFixture } = await import('./helpers.js');
        const { randomUUID } = await import('node:crypto');
        const trip = await repository.createSession({ ...sessionFixture(randomUUID()), ownerId: person.id });
        return { person, trip };
      }),
    );
    const plan = (t: (typeof trips)[number], addr: string) =>
      bare.inject({ method: 'POST', url: `/v1/trips/${t.trip.id}/plan`, headers: { cookie: t.person.cookie }, remoteAddress: addr });

    expect((await plan(trips[0]!, ADDR_A)).statusCode).toBe(202);
    expect((await plan(trips[1]!, ADDR_A)).statusCode).toBe(202);
    const refused = await plan(trips[2]!, ADDR_A); // a third *different* anonymous person, same address
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe('daily_search_limit_address');
    // Nothing was queued for it.
    expect(await repository.activeRunForTrip(trips[2]!.trip.id)).toBeNull();
    // Another address is fine.
    expect((await plan(trips[3]!, ADDR_B)).statusCode).toBe(202);

    // Someone who has signed in is not held to the address's anonymous allowance.
    const member = await signedInUser(repository, ctx.env, 'member@example.com');
    const { sessionFixture } = await import('./helpers.js');
    const { randomUUID } = await import('node:crypto');
    const memberTrip = await repository.createSession({ ...sessionFixture(randomUUID()), ownerId: member.id });
    const ok = await bare.inject({ method: 'POST', url: `/v1/trips/${memberTrip.id}/plan`, headers: { cookie: member.cookie }, remoteAddress: ADDR_A });
    expect(ok.statusCode).toBe(202);
  });

  it('does not count a search that reused a running one, or was refused for another reason', async () => {
    const { app, repository } = await buildTestApp({ envVars: { PLAN_RUNS_PER_DAY_PER_ADDRESS: '2' } });
    // Anonymous owner: the fixture's owner has no email.
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan`, remoteAddress: ADDR_A });
      expect(res.statusCode).toBe(202); // the second and later reuse the first
    }
    expect((await repository.latestRunForTrip(TRIP_ID))?.status).toBe('queued');
  });
});
