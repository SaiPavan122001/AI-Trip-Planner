import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildContext, type AppContext } from './context.js';
import { corsOrigins } from './env.js';
import { sendError } from './errors.js';
import { registerBookingRoutes } from './routes/bookings.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerTripRoutes } from './routes/trips.js';

export async function buildServer(overrides: Partial<AppContext> = {}): Promise<{
  app: FastifyInstance;
  ctx: AppContext;
}> {
  const ctx = await buildContext(overrides);

  const app = Fastify({
    // Cast to Fastify's own logger interface: pino's concrete type carries
    // extra generics that would otherwise leak into every route's signature.
    loggerInstance: ctx.logger as FastifyBaseLogger,
    // A request id on every log line and error response is what makes a
    // traveller's "it said something went wrong" traceable.
    genReqId: () => randomUUID(),
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: corsOrigins(ctx.env),
    credentials: true,
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'x-user-id'],
  });
  await app.register(rateLimit, {
    max: ctx.env.RATE_LIMIT_MAX,
    timeWindow: ctx.env.RATE_LIMIT_WINDOW,
    // Planning fans out to paid provider APIs, so the limit protects the
    // operator's bill as much as the service.
    keyGenerator: (req) => (req.headers['x-user-id'] as string) ?? req.ip,
  });

  // Several endpoints are commands with no payload (`POST /plan`). Browsers
  // and fetch clients still send `Content-Type: application/json`, and Fastify
  // rejects that combination by default. Treating an empty body as `{}` keeps
  // a legitimate request from failing on a header.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body: string, done) => {
      if (body === undefined || body === null || body.trim() === '') {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch (err) {
        (err as Error & { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

  app.setErrorHandler((err, _req, reply) => sendError(reply, err));
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({
      error: { code: 'not_found', message: `No route matches ${req.method} ${req.url}.` },
    }),
  );

  registerSystemRoutes(app, ctx);
  registerTripRoutes(app, ctx);
  registerBookingRoutes(app, ctx);

  return { app, ctx };
}
