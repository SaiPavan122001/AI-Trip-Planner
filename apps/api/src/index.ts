import { buildServer } from './server.js';

/**
 * Entry point. Shutdown is explicit: in-flight planning requests are given a
 * chance to finish so a traveller mid-search does not get a dropped connection
 * during a deploy.
 */
async function main(): Promise<void> {
  const { app, ctx } = await buildServer();

  const shutdown = async (signal: string) => {
    ctx.logger.info({ signal }, 'Shutting down');
    await app.close();
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
    },
    `Trip planner API listening on ${ctx.env.HOST}:${ctx.env.PORT}`,
  );
}

main().catch((err) => {
  console.error('Failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
