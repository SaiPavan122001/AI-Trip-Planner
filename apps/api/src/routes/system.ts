import type { FastifyInstance } from 'fastify';
import { SingleFlight } from '@trip/shared';
import type { AppContext } from '../context.js';
import { ApiError, sendError } from '../errors.js';
import { securityEvent } from '../security/events.js';

/** How long one live probe of every provider is reused. Probes cost money and time, and a busy page must not multiply them. */
const HEALTH_REUSE_MS = 30_000;

/**
 * Operational endpoints. `/v1/providers` is also a product surface: the UI
 * reads it to tell a traveller which sources are live, which are not
 * configured, and what each missing one would add.
 */
export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Probe calls are shared: everyone who asks within the window gets one probe.
  const probes = new SingleFlight<Awaited<ReturnType<AppContext['registry']['healthReport']>>>();
  let lastProbe: { at: number; report: Awaited<ReturnType<AppContext['registry']['healthReport']>> } | null = null;

  // Kept for existing probes and dashboards: the store's state, without the reason. New probes use /live and /ready.
  app.get('/health', { config: { limit: false } }, async (req, reply) => {
    const { cause, ...store } = await ctx.repository.healthCheck();
    if (cause) req.log.error({ cause }, 'Store health check failed');
    return reply.status(store.ok ? 200 : 503).send({
      status: store.ok ? 'ok' : 'degraded',
      store,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  /**
   * Liveness: is this process running and able to answer? It touches nothing
   * else, on purpose. A process is restarted when this fails, and a database that
   * is down or a provider that is slow must never be a reason to restart it.
   */
  app.get('/live', { config: { limit: false } }, async (_req, reply) =>
    reply.send({ status: 'alive', uptimeSeconds: Math.round(process.uptime()) }),
  );

  /**
   * Readiness: can this instance accept work? Yes when the database answers, the
   * search queue can be read, and a place lookup is configured (nothing can be
   * classified without one). It does **not** depend on any optional travel
   * provider being up, on Redis (limits and the cache fall back to this process),
   * on the language model, or on the queue being full (turning away searches is
   * this service doing its job; taking the instance out of rotation would only
   * move the load). Those states are in `GET /ops/status`, for the operator.
   */
  app.get('/ready', { config: { limit: false } }, async (req, reply) => {
    const { cause, ...store } = await ctx.repository.healthCheck();
    if (cause) req.log.error({ cause }, 'Store health check failed');
    let queueReadable = false;
    if (store.ok) {
      try {
        await ctx.repository.countQueuedRuns();
        queueReadable = true;
      } catch (err) {
        req.log.error({ operation: 'ready.queue', errorCategory: 'dependency_unavailable', err: err instanceof Error ? err.name : 'error' }, 'The search queue could not be read');
      }
    }
    const canResolvePlaces = ctx.registry.geocoding.length > 0;
    const ready = store.ok && queueReadable && canResolvePlaces;
    return reply.status(ready ? 200 : 503).send({
      ready,
      store: store.store,
      geocoding: canResolvePlaces ? 'available' : 'not configured',
    });
  });

  app.get('/v1/providers', async (_req, reply) => {
    try {
      // What is missing is product information (the page tells a traveller what a
      // source would add). Which environment variable to set, and why a source
      // is off, is information about the deployment, so it is left out where an
      // outsider can read it.
      const details = ctx.env.EXPOSE_PROVIDER_DETAILS;
      return reply.send({
        configured: ctx.registry.all().map((p) => ({
          id: p.descriptor.id,
          label: p.descriptor.label,
          kinds: p.descriptor.kinds,
          coverage: p.descriptor.coverage,
          docsUrl: p.descriptor.docsUrl,
          attribution: p.descriptor.attribution,
        })),
        disabled: ctx.registry.disabled.map((d) =>
          details
            ? d
            : {
                ...d,
                requiredEnv: [],
                reason: 'Not connected in this deployment.',
                // What a missing source would add is product information; how to switch it on is not.
                capabilities: Object.fromEntries(Object.keys(d.capabilities).map((c) => [c, 'Not connected in this deployment.'])),
              },
        ),
        llm: { available: ctx.llm.available, label: ctx.llm.label },
        /** Stated plainly so the UI can show it without interpretation. */
        dataPolicy:
          'Every price, schedule and availability shown comes from a connected provider and is labelled with its source and retrieval time. Where a provider is unavailable, this planner says so rather than substituting an estimate.',
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * Live probe of every connected provider. Slow by nature, some probes make a
   * real billed request, and it says which providers are down: off in
   * production unless the operator turns it on, limited per address, and
   * shared, so a crowd asking at once causes one round of probes, not many.
   */
  app.get(
    '/v1/providers/health',
    { config: { limit: 'providers.health' } },
    async (req, reply) => {
      try {
        if (!ctx.env.EXPOSE_PROVIDER_HEALTH) {
          securityEvent(ctx.logger, 'forbidden_provider_probe', { route: '/v1/providers/health', method: 'GET', address: req.addressTag });
          throw ApiError.forbidden('not_available', 'The live provider check is not available on this deployment.');
        }
        const now = Date.now();
        const report =
          lastProbe && now - lastProbe.at < HEALTH_REUSE_MS
            ? lastProbe.report
            : await probes.run('all', async () => {
                const fresh = await ctx.registry.healthReport();
                lastProbe = { at: Date.now(), report: fresh };
                return fresh;
              });
        const anyDown = report.some((r) => r.result.status !== 'ok');
        return reply.status(anyDown ? 207 : 200).send({
          providers: report.map((r) => ({
            id: r.id,
            label: r.label,
            kinds: r.kinds,
            status: r.result.status,
            detail: r.result.status === 'ok' ? `${r.result.data.latencyMs}ms` : r.result.message,
          })),
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
