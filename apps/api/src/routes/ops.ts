import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ResilientPolicy } from '@trip/providers';
import { isTracingInstalled, registry } from '@trip/telemetry';
import type { AppContext } from '../context.js';
import { ApiError, sendError } from '../errors.js';
import { securityEvent } from '../security/events.js';
import type { RateLimitKit } from '../security/rate-limit.js';

/**
 * What an operator sees: `GET /metrics` (Prometheus text) and `GET /ops/status`
 * (a compact JSON view of the service's own state).
 *
 * Both are closed unless the operator opens them. With no `OPS_TOKEN` set they
 * answer 404, as though they did not exist; with one, they need
 * `Authorization: Bearer <token>`, compared without leaking how much of it was
 * right, and an address that gets it wrong repeatedly is locked out for a while.
 * Neither shows a secret, an address, a person, a trip or anything a traveller
 * wrote: metrics carry only closed or capped labels (`@trip/telemetry`), and the
 * status view carries states and counts.
 */

const digest = (value: string) => createHash('sha256').update(value).digest();

export function registerOpsRoutes(app: FastifyInstance, ctx: AppContext, limits: RateLimitKit): void {
  const enabled = () => ctx.env.TELEMETRY_ENABLED && ctx.env.OPS_TOKEN !== undefined;

  /** Throws unless the caller holds the operator token. Counts (and eventually locks out) wrong tries. */
  async function requireOps(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!enabled()) throw ApiError.notFound('That page');
    const caller = limits.callerOf(req);
    const failed = limits.policies['ops.failed'];
    const lock = await limits.limiter.isLocked(failed, caller);
    if (lock.locked) {
      reply.header('retry-after', String(lock.retryAfterSeconds));
      throw ApiError.tooManyRequests('too_many_failed_attempts', 'Too many wrong tokens from this connection. Wait and try again.', {
        retryAfterSeconds: lock.retryAfterSeconds,
      });
    }
    const header = req.headers.authorization;
    const presented = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    // Hashing first makes both sides the same length, so the comparison takes the same time whatever was sent.
    const ok = presented.length > 0 && timingSafeEqual(digest(presented), digest(ctx.env.OPS_TOKEN!));
    if (!ok) {
      await limits.limiter.record(failed, caller);
      securityEvent(ctx.logger, 'ops_auth_failed', { route: req.routeOptions.url ?? 'ops', method: req.method, address: caller.address });
      throw ApiError.unauthorized('A valid operator token is needed.');
    }
  }

  app.get('/metrics', { config: { limit: 'ops' } }, async (req, reply) => {
    try {
      await requireOps(req, reply);
      return reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8').send(await registry.render());
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/ops/status', { config: { limit: 'ops' } }, async (req, reply) => {
    try {
      await requireOps(req, reply);
      const store = await ctx.repository.healthCheck().catch(() => ({ ok: false, store: 'unknown' }));
      const queued = await ctx.repository.countQueuedRuns().then(
        (n) => n,
        () => null,
      );
      const policy = ctx.registry.policy;
      const circuits = policy instanceof ResilientPolicy ? policy.circuitStates() : [];
      return reply.send({
        service: ctx.env.SERVICE_NAME ?? 'trip-api',
        environment: ctx.env.NODE_ENV,
        uptimeSeconds: Math.round(process.uptime()),
        store: { ok: store.ok, kind: store.store },
        queue: { queued, capacity: ctx.env.MAX_QUEUED_RUNS, workerInThisProcess: ctx.env.RUN_WORKER },
        redis: ctx.infra.redisState(),
        providers: {
          connected: ctx.registry.all().map((p) => p.descriptor.id),
          circuits,
          degraded: circuits.some((c) => c.state !== 'closed'),
        },
        llm: { available: ctx.llm.available },
        knowledge: ctx.knowledge ? await ctx.knowledge.status().catch(() => ({ enabled: true, error: 'unavailable' })) : { enabled: false },
        cache: { enabled: ctx.registry.cache !== null },
        telemetry: { tracing: isTracingInstalled(), exporting: ctx.env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined, sampleRatio: ctx.env.OTEL_TRACES_SAMPLER_ARG },
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
