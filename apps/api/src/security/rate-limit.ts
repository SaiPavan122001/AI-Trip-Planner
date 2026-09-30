import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import type { Env } from '../env.js';
import { metrics } from '@trip/telemetry';
import { ApiError, sendError } from '../errors.js';
import type { CounterStore } from '../infra/counters.js';
import { addressTag, securityEvent } from './events.js';

/**
 * Application-level rate limiting.
 *
 * Every request is counted on two dimensions, and both must have room:
 *
 *   - the person (the signed-in user, or the anonymous one), and
 *   - the address it came from.
 *
 * The second is what makes the limits mean something. Anyone can become a new
 * anonymous person by not sending a cookie; if only the person were counted,
 * clearing cookies would be a fresh allowance every time. The address is the
 * one thing a caller cannot change for free, so it is counted whatever the
 * person says, with a higher ceiling (people share addresses at offices,
 * schools and behind carrier NAT) than the one for a person. Nothing here
 * tracks anyone: an address is only ever a keyed hash (`events.ts`), counted
 * for the length of a window.
 *
 * The counters are shared (Redis) when Redis is configured, so the limit holds
 * across instances; see `infra/counters.ts` for what happens when it is away.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface LimitRule {
  /**
   * `user`: the person, once there is one. `address`: where it came from, whoever the person says
   * they are. `anonymous_address`: where it came from, but only while there is no person yet, which
   * is how a caller who has not signed in or planned anything is held tighter than one who has.
   */
  scope: 'user' | 'address' | 'anonymous_address';
  max: number;
  windowMs: number;
  /** How the limit reads in a message to the caller: "requests", "sign-in emails". */
  what?: string;
}

export interface LimitPolicy {
  name: string;
  rules: LimitRule[];
}

export interface Caller {
  /** The signed-in or anonymous person; null before any session exists. */
  userId: string | null;
  /** A keyed tag of the address (never the address). */
  address: string;
}

export type LimitDecision =
  | { allowed: true; limit: number; remaining: number; resetSeconds: number }
  | { allowed: false; limit: number; retryAfterSeconds: number; rule: LimitRule; policy: string };

// The window is part of the key: a policy may count the same address over a minute and over a day, and those are two counters.
const key = (policy: string, rule: LimitRule, caller: Caller) =>
  `${policy}:${rule.scope}:${rule.windowMs}:${rule.scope === 'user' ? caller.userId : caller.address}`;
const applies = (rule: LimitRule, caller: Caller) =>
  rule.scope === 'address' || (rule.scope === 'user' ? caller.userId !== null : caller.userId === null);

export class RateLimiter {
  constructor(private readonly store: CounterStore) {}

  get kind(): CounterStore['kind'] {
    return this.store.kind;
  }

  /** Counts this request against every rule of the policy, and says whether it is allowed. */
  async consume(policy: LimitPolicy, caller: Caller): Promise<LimitDecision> {
    let tightest: { limit: number; remaining: number; resetMs: number } | null = null;
    let denied: { rule: LimitRule; resetMs: number } | null = null;
    for (const rule of policy.rules) {
      if (!applies(rule, caller)) continue;
      const { count, resetMs } = await this.store.hit(key(policy.name, rule, caller), rule.windowMs);
      if (count > rule.max) {
        if (!denied || resetMs > denied.resetMs) denied = { rule, resetMs };
        continue;
      }
      const remaining = rule.max - count;
      if (!tightest || remaining < tightest.remaining) tightest = { limit: rule.max, remaining, resetMs };
    }
    if (denied) {
      return {
        allowed: false,
        limit: denied.rule.max,
        retryAfterSeconds: Math.max(1, Math.ceil(denied.resetMs / SECOND)),
        rule: denied.rule,
        policy: policy.name,
      };
    }
    const t = tightest ?? { limit: 0, remaining: 0, resetMs: 0 };
    return { allowed: true, limit: t.limit, remaining: t.remaining, resetSeconds: Math.ceil(t.resetMs / SECOND) };
  }

  /** Whether the caller is already at the limit, without counting anything. */
  async isLocked(policy: LimitPolicy, caller: Caller): Promise<{ locked: false } | { locked: true; retryAfterSeconds: number }> {
    for (const rule of policy.rules) {
      if (!applies(rule, caller)) continue;
      const { count, resetMs } = await this.store.peek(key(policy.name, rule, caller));
      if (count >= rule.max) return { locked: true, retryAfterSeconds: Math.max(1, Math.ceil(resetMs / SECOND)) };
    }
    return { locked: false };
  }

  /** Counts one event against a policy without deciding anything: for limits on failures only. */
  async record(policy: LimitPolicy, caller: Caller): Promise<void> {
    for (const rule of policy.rules) {
      if (applies(rule, caller)) await this.store.hit(key(policy.name, rule, caller), rule.windowMs);
    }
  }
}

// ----------------------------------------------------------------- policies

/** "1 minute", "30 seconds", "2 hours": the form the existing setting was written in. */
export function parseDuration(text: string): number {
  const m = /^\s*(\d+)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hour|hours|d|day|days)\s*$/i.exec(text);
  if (!m) throw new Error(`"${text}" is not a duration such as "1 minute" or "30 seconds".`);
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  if (unit === 'ms') return n;
  if (unit.startsWith('s')) return n * SECOND;
  if (unit.startsWith('m')) return n * MINUTE;
  if (unit.startsWith('h')) return n * HOUR;
  return n * DAY;
}

export type PolicyName =
  | 'all'
  | 'trips.create'
  | 'trips.plan'
  | 'trips.modify'
  | 'ai.read'
  | 'knowledge.ask'
  | 'places'
  | 'providers.health'
  | 'auth.magic_link'
  | 'auth.verify'
  | 'auth.verify_failed'
  | 'account.heavy'
  | 'ops'
  | 'ops.failed';

/**
 * Every limit in one place. The first is for every request; the others are
 * named by the route that uses them (`config: { limit: 'trips.plan' }`), and
 * apply as well as the first.
 *
 * Per-person limits are the ones a legitimate user could hit only by
 * hammering; per-address limits are two to four times as high, so a family or
 * an office behind one address is not locked out by its busiest member.
 */
export function buildPolicies(env: Env): Record<PolicyName, LimitPolicy> {
  const window = parseDuration(env.RATE_LIMIT_WINDOW);
  return {
    all: {
      name: 'all',
      rules: [
        { scope: 'user', max: env.RATE_LIMIT_MAX, windowMs: window, what: 'requests' },
        { scope: 'address', max: env.RATE_LIMIT_ADDRESS_MAX, windowMs: window, what: 'requests' },
      ],
    },
    // Making a first trip is what mints an anonymous person, so while there is
    // no person yet it is counted per address tightly: this is the door the
    // cookie-rotation trick goes through.
    'trips.create': {
      name: 'trips.create',
      rules: [
        { scope: 'user', max: 30, windowMs: HOUR, what: 'new trips' },
        { scope: 'anonymous_address', max: 30, windowMs: HOUR, what: 'new trips' },
        { scope: 'address', max: 90, windowMs: HOUR, what: 'new trips' },
      ],
    },
    // Each search fans out to paid provider APIs.
    'trips.plan': {
      name: 'trips.plan',
      rules: [
        { scope: 'user', max: 12, windowMs: MINUTE, what: 'searches' },
        { scope: 'address', max: 40, windowMs: MINUTE, what: 'searches' },
      ],
    },
    'trips.modify': {
      name: 'trips.modify',
      rules: [
        { scope: 'user', max: 20, windowMs: MINUTE, what: 'changes' },
        { scope: 'address', max: 60, windowMs: MINUTE, what: 'changes' },
      ],
    },
    // Reading a message in words may call a language model, and needs no session.
    'ai.read': {
      name: 'ai.read',
      rules: [
        { scope: 'user', max: 10, windowMs: MINUTE, what: 'requests' },
        { scope: 'anonymous_address', max: 10, windowMs: MINUTE, what: 'requests' },
        { scope: 'address', max: 30, windowMs: MINUTE, what: 'requests' },
        { scope: 'address', max: 300, windowMs: DAY, what: 'requests' },
      ],
    },
    // A knowledge question embeds the question and may call a language model, and needs a session: an address that
    // has never planned anything gets no answers, and one that has is held to what a person can plausibly ask.
    'knowledge.ask': {
      name: 'knowledge.ask',
      rules: [
        { scope: 'user', max: 10, windowMs: MINUTE, what: 'questions' },
        { scope: 'user', max: 200, windowMs: DAY, what: 'questions' },
        { scope: 'address', max: 30, windowMs: MINUTE, what: 'questions' },
        { scope: 'address', max: 500, windowMs: DAY, what: 'questions' },
      ],
    },
    places: {
      name: 'places',
      rules: [
        { scope: 'user', max: 40, windowMs: MINUTE, what: 'lookups' },
        { scope: 'address', max: 120, windowMs: MINUTE, what: 'lookups' },
      ],
    },
    'providers.health': { name: 'providers.health', rules: [{ scope: 'address', max: 5, windowMs: MINUTE, what: 'probes' }] },
    // Each request sends an email to an address the caller names.
    'auth.magic_link': {
      name: 'auth.magic_link',
      rules: [
        { scope: 'user', max: 10, windowMs: HOUR, what: 'sign-in emails' },
        // Generous per address (an office or a school signs in together); the
        // per-recipient limit in the auth service is what stops one inbox being flooded.
        { scope: 'address', max: 30, windowMs: HOUR, what: 'sign-in emails' },
        { scope: 'address', max: 100, windowMs: DAY, what: 'sign-in emails' },
      ],
    },
    'auth.verify': { name: 'auth.verify', rules: [{ scope: 'address', max: 20, windowMs: 10 * MINUTE, what: 'sign-in attempts' }] },
    // Counted only when a link is refused: a run of wrong links from one
    // address locks that address out of signing in for a while.
    'auth.verify_failed': { name: 'auth.verify_failed', rules: [{ scope: 'address', max: 8, windowMs: 15 * MINUTE, what: 'failed sign-in attempts' }] },
    // The operator's endpoints: scraped often, so the ceiling is high; wrong tokens are counted and lock the address out.
    ops: { name: 'ops', rules: [{ scope: 'address', max: 240, windowMs: MINUTE, what: 'operator requests' }] },
    'ops.failed': { name: 'ops.failed', rules: [{ scope: 'address', max: 10, windowMs: 15 * MINUTE, what: 'wrong operator tokens' }] },
    // Exporting or deleting an account is rare and not cheap.
    'account.heavy': { name: 'account.heavy', rules: [{ scope: 'user', max: 5, windowMs: HOUR, what: 'account requests' }] },
  };
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Which limit applies to this route; `false` for none (health probes). */
    limit?: PolicyName | false;
  }
  interface FastifyRequest {
    /** A keyed tag of the caller's address; never the address itself. */
    addressTag: string;
  }
}

export interface RateLimitKit {
  limiter: RateLimiter;
  policies: Record<PolicyName, LimitPolicy>;
  /** The caller behind a request, as the limiter knows them. */
  callerOf(req: FastifyRequest): Caller;
}

/** Gives every request its address tag, before anything else looks at who is asking. */
export function registerCallerTag(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('addressTag', '');
  app.addHook('onRequest', async (req) => {
    req.addressTag = addressTag(ctx.env.sessionSecret, req.ip);
  });
}

export function registerRateLimiting(app: FastifyInstance, ctx: AppContext): RateLimitKit {
  const limiter = new RateLimiter(ctx.infra.counters);
  const policies = buildPolicies(ctx.env);
  const callerOf = (req: FastifyRequest): Caller => ({ userId: req.principal?.userId ?? null, address: req.addressTag });

  // After the session has been read (the auth hook is registered first), so a
  // person is counted as themselves.
  app.addHook('onRequest', async (req, reply) => {
    const chosen = req.routeOptions.config?.limit;
    if (chosen === false) return undefined;
    const caller = callerOf(req);

    const routeName = chosen as PolicyName | undefined;
    const applicable = [policies.all, ...(routeName ? [policies[routeName]] : [])];

    let headers: { limit: number; remaining: number; resetSeconds: number } | null = null;
    for (const policy of applicable) {
      const decision = await limiter.consume(policy, caller);
      // Accepted and rejected requests, by policy name (a bounded list), never by who.
      metrics.rateLimitDecisions.inc({ policy: policy.name, decision: decision.allowed ? 'allowed' : 'rejected' });
      if (!decision.allowed) {
        securityEvent(ctx.logger, 'rate_limited', { route: req.routeOptions.url ?? 'unmatched', method: req.method, address: caller.address, userId: caller.userId }, { policy: decision.policy, limit: decision.limit });
        reply.header('retry-after', String(decision.retryAfterSeconds));
        return sendError(
          reply,
          ApiError.tooManyRequests(
            'rate_limited',
            `Too many ${decision.rule.what ?? 'requests'} just now. Please wait ${formatWait(decision.retryAfterSeconds)} and try again.`,
            { retryAfterSeconds: decision.retryAfterSeconds },
          ),
        );
      }
      if (!headers || decision.remaining < headers.remaining) headers = decision;
    }
    if (headers) {
      reply.header('ratelimit-limit', String(headers.limit));
      reply.header('ratelimit-remaining', String(headers.remaining));
      reply.header('ratelimit-reset', String(headers.resetSeconds));
    }
    return undefined;
  });

  return { limiter, policies, callerOf };
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  return `${Math.ceil(minutes / 60)} hours`;
}
