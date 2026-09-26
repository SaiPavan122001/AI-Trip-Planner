import { buildContext } from './context.js';

/**
 * A process that only runs background searches. Run as many as needed next to
 * the API (which then sets RUN_WORKER=false): they share the queue in
 * PostgreSQL and never take the same run twice.
 */
async function main(): Promise<void> {
  const ctx = await buildContext();
  if (!ctx.env.DATABASE_URL) {
    throw new Error('The worker needs DATABASE_URL: it shares the search queue with the API through the database.');
  }
  ctx.worker.start();

  const shutdown = async (signal: string) => {
    ctx.logger.info({ signal }, 'Worker shutting down');
    await ctx.worker.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Failed to start the worker:', err instanceof Error ? err.message : err);
  process.exit(1);
});
