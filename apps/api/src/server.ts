import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { categoryOfHttp, metrics, startManualSpan, statusClassOf, withCorrelation, type ManualSpan } from '@trip/telemetry';
import { registerAuth } from './auth/plugin.js';
import { registerAuthRoutes } from './auth/routes.js';
import { buildContext, type AppContext, type ContextOverrides } from './context.js';
import { corsOrigins, trustProxyOption } from './env.js';
import { labelled, sendError } from './errors.js';
import { registerOpsRoutes } from './routes/ops.js';
import { registerBookingRoutes } from './routes/bookings.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerKnowledgeRoutes } from './routes/knowledge.js';
import { registerTripRoutes } from './routes/trips.js';
import { registerCallerTag, registerRateLimiting, type RateLimitKit } from './security/rate-limit.js';

export async function buildServer(overrides: ContextOverrides = {}): Promise<{
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
    // Believing X-Forwarded-For from anyone lets a caller choose their own
    // rate-limit identity, so it is opt-in and says which proxies to trust.
    trustProxy: trustProxyOption(ctx.env),
    // Every legitimate request is a few kilobytes. A larger body is refused
    // before it is parsed, so it costs almost nothing to send and to refuse.
    bodyLimit: ctx.env.MAX_BODY_BYTES,
    // A slow client cannot hold a connection open indefinitely.
    requestTimeout: 30_000,
    connectionTimeout: 60_000,
    // A path parameter is an id; nothing legitimate is longer than this.
    routerOptions: { maxParamLength: 200 },
  });

  // This service returns JSON and nothing else, so its content security policy
  // is the strictest there is: nothing it returns may load anything, or be framed.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] },
    },
    referrerPolicy: { policy: 'no-referrer' },
  });
  await app.register(cors, {
    origin: corsOrigins(ctx.env),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'idempotency-key'],
    // What a browser client may read: when to come back, and whether an answer was replayed.
    exposedHeaders: ['retry-after', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'idempotent-replay', 'x-request-id', 'x-error-category'],
  });

  // Nothing this service returns is meant to be kept by a browser or a shared
  // cache: it is about one person's trips. The request id goes back so a
  // problem report can be matched to its log lines.
  app.addHook('onSend', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-request-id', req.id);
  });

  // The first hook of every request: it starts the request's span and its correlation
  // context, and everything after it (auth, limits, the route, the store, the
  // providers) runs inside both. The `done` callback is what carries the context
  // forward; an async hook could not.
  const inFlight = new WeakMap<object, { span: ManualSpan; started: number }>();
  const QUIET = new Set(['/live', '/health', '/ready', '/metrics']);
  app.addHook('onRequest', (req, _reply, done) => {
    const route = req.routeOptions?.url ?? 'unmatched';
    const started = performance.now();
    if (QUIET.has(route)) {
      // Probes and scrapes are counted, but a trace of each would drown the real ones.
      inFlight.set(req, { span: { span: undefined as never, activate: (fn) => fn(), end: () => undefined }, started });
      withCorrelation({ requestId: req.id }, done);
      return;
    }
    // The correlation context comes first, so the request's own span carries its id.
    // A traceparent sent by a caller is not continued: anyone could send one, and a trace is ours to start.
    withCorrelation({ requestId: req.id }, () => {
      const span = startManualSpan('http.request', { 'http.request.method': req.method, 'http.route': route }, { kind: 'server' });
      inFlight.set(req, { span, started });
      span.activate(done);
    });
  });
  app.addHook('onResponse', async (req, reply) => {
    const entry = inFlight.get(req);
    if (!entry) return;
    inFlight.delete(req);
    const route = req.routeOptions?.url ?? 'unmatched';
    const status = reply.statusCode;
    const category = categoryOfHttp(status);
    const method = req.method;
    metrics.httpRequests.inc({ method, route, status_class: statusClassOf(status) });
    metrics.httpDuration.observe({ method, route }, (performance.now() - entry.started) / 1000);
    if (category) metrics.httpErrors.inc({ category, route });
    entry.span.end({ failed: status >= 500, ...(category ? { category } : {}), attributes: { 'http.response.status_code': status } });
  });
  // A caller that hung up: the request ended without an answer.
  app.addHook('onRequestAbort', async (req) => {
    const entry = inFlight.get(req);
    if (!entry) return;
    inFlight.delete(req);
    metrics.httpErrors.inc({ category: 'cancelled', route: req.routeOptions?.url ?? 'unmatched' });
    entry.span.end({ category: 'cancelled' });
  });

  // Who is asking, in the only form the rest ever sees: a keyed tag of the address.
  registerCallerTag(app, ctx);
  // Registered before the rate limiter, so the limiter can count the person.
  await registerAuth(app, ctx, ctx.auth);
  const limits: RateLimitKit = registerRateLimiting(app, ctx);

  // Several endpoints are commands with no payload (`POST /plan`). Browsers
  // and fetch clients still send `Content-Type: application/json`, and Fastify
  // rejects that combination by default. Treating an empty body as `{}` keeps
  // a legitimate request from failing on a header.
  // Only JSON is read. A browser cannot send a cross-site request with a JSON
  // content type without asking permission first (a preflight, which this
  // service answers only to its own web app), so refusing every other body type
  // shuts the "simple request" form of cross-site forgery (a form post, or
  // text/plain) whatever else is true of the cookie.
  app.removeAllContentTypeParsers();
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
  // Says nothing about what was asked for: echoing the address back is how
  // probing tools learn what a server reflects.
  app.setNotFoundHandler((_req, reply) =>
    labelled(reply, 404, 'not_found').status(404).send({ error: { code: 'not_found', message: 'There is nothing at that address.' } }),
  );

  registerSystemRoutes(app, ctx);
  registerOpsRoutes(app, ctx, limits);
  registerAuthRoutes(app, ctx, ctx.auth, limits);
  registerTripRoutes(app, ctx, ctx.auth);
  registerBookingRoutes(app, ctx);
  registerKnowledgeRoutes(app, ctx);

  app.addHook('onClose', async () => {
    await ctx.infra.close();
  });

  return { app, ctx };
}
