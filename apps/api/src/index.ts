import { buildServer } from './server.js';

/**
 * Entry point. Shutdown is explicit: in-flight requests and, when this
 * process runs searches, in-flight searches are given a chance to finish so a
 * traveller mid-search does not lose their plans during a deploy.
 */
async function main(): Promise<void> {
  const { app, ctx } = await buildServer();

  if (ctx.env.RUN_WORKER) {
    ctx.worker.start();
  } else if (!ctx.env.DATABASE_URL) {
    // Searches run in the worker. A separate process cannot share an
    // in-memory store, so with no database and no in-process worker, every
    // search would queue forever.
    throw new Error('RUN_WORKER=false needs DATABASE_URL: a separate worker can only share a real database.');
  } else {
    ctx.logger.info('Not running searches in this process (RUN_WORKER=false); start the worker separately.');
  }

  const shutdown = async (signal: string) => {
    ctx.logger.info({ signal }, 'Shutting down');
    await app.close();
    await ctx.worker.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: ctx.env.PORT, host: ctx.env.HOST });
  ctx.logger.info(
    {
      providers: ctx.registry.all().map((p) => p.descriptor.id),
      disabled: ctx.registry.disabled.map((d) => d.id),
      llm: ctx.llm.label,
      mailer: ctx.mailer.kind,
      searchesRunHere: ctx.env.RUN_WORKER,
    },
    `Trip planner API listening on ${ctx.env.HOST}:${ctx.env.PORT}`,
  );
}

main().catch((err) => {
  console.error('Failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
