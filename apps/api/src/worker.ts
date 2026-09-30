import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { registry } from '@trip/telemetry';
import { buildContext } from './context.js';

/**
 * A process that only runs background searches. Run as many as needed next to
 * the API (which then sets RUN_WORKER=false): they share the queue in
 * PostgreSQL and never take the same run twice.
 */
async function main(): Promise<void> {
  const ctx = await buildContext({ serviceName: process.env['SERVICE_NAME'] ?? 'trip-worker' });
  if (!ctx.env.DATABASE_URL) {
    throw new Error('The worker needs DATABASE_URL: it shares the search queue with the API through the database.');
  }
  ctx.worker.start();

  // A worker has no HTTP server, but the searches it runs are where the planning
  // metrics are recorded. With WORKER_METRICS_PORT set it answers /live (nothing
  // else touched) and, with OPS_TOKEN set, /metrics. Nothing else.
  const metricsServer = ctx.env.WORKER_METRICS_PORT
    ? createServer((req, res) => {
        const send = (status: number, body: string, type = 'application/json') => {
          res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
          res.end(body);
        };
        if (req.method === 'GET' && req.url === '/live') return send(200, JSON.stringify({ status: 'alive' }));
        if (req.method === 'GET' && req.url === '/metrics' && ctx.env.OPS_TOKEN) {
          const presented = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
          const digest = (v: string) => createHash('sha256').update(v).digest();
          if (presented && timingSafeEqual(digest(presented), digest(ctx.env.OPS_TOKEN))) {
            void registry.render().then((text) => send(200, text, 'text/plain; version=0.0.4; charset=utf-8'));
            return;
          }
          return send(401, JSON.stringify({ error: { code: 'unauthorized', message: 'A valid operator token is needed.' } }));
        }
        return send(404, JSON.stringify({ error: { code: 'not_found', message: 'There is nothing at that address.' } }));
      }).listen(ctx.env.WORKER_METRICS_PORT, ctx.env.HOST)
    : null;

  const shutdown = async (signal: string) => {
    ctx.logger.info({ signal }, 'Worker shutting down');
    await ctx.worker.stop();
    metricsServer?.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Failed to start the worker:', err instanceof Error ? err.message : err);
  process.exit(1);
});
