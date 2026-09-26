import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { sendError } from '../errors.js';

/**
 * Operational endpoints. `/v1/providers` is also a product surface: the UI
 * reads it to tell a traveller which sources are live, which are not
 * configured, and what each missing one would add.
 */
export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/health', async (req, reply) => {
    const { cause, ...store } = await ctx.repository.healthCheck();
    if (cause) req.log.error({ cause }, 'Store health check failed');
    return reply.status(store.ok ? 200 : 503).send({
      status: store.ok ? 'ok' : 'degraded',
      store,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  /** Kubernetes-style readiness: can this instance actually serve a request? */
  app.get('/ready', async (req, reply) => {
    const { cause, ...store } = await ctx.repository.healthCheck();
    if (cause) req.log.error({ cause }, 'Store health check failed');
    const canResolvePlaces = ctx.registry.geocoding.length > 0;
    const ready = store.ok && canResolvePlaces;
    return reply.status(ready ? 200 : 503).send({
      ready,
      store: store.store,
      geocoding: canResolvePlaces ? 'available' : 'not configured',
    });
  });

  app.get('/v1/providers', async (_req, reply) => {
    try {
      return reply.send({
        configured: ctx.registry.all().map((p) => ({
          id: p.descriptor.id,
          label: p.descriptor.label,
          kinds: p.descriptor.kinds,
          coverage: p.descriptor.coverage,
          docsUrl: p.descriptor.docsUrl,
          attribution: p.descriptor.attribution,
        })),
        disabled: ctx.registry.disabled,
        llm: { available: ctx.llm.available, label: ctx.llm.label },
        /** Stated plainly so the UI can show it without interpretation. */
        dataPolicy:
          'Every price, schedule and availability shown comes from a connected provider and is labelled with its source and retrieval time. Where a provider is unavailable, this planner says so rather than substituting an estimate.',
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Live probe of every connected provider. Slow by nature; not for the hot path. */
  app.get(
    '/v1/providers/health',
    // Some probes make a real, billed request, so this is deliberately tight.
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      try {
        const report = await ctx.registry.healthReport();
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
