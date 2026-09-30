import { embedderFromEnv, InMemoryKnowledgeStore, type KnowledgeStore } from '@trip/knowledge';
import { ProviderRegistry, type PolicyEvent } from '@trip/providers';
import type { PlanningServices } from '@trip/agents';
import { llmFromEnv, type TripLlm } from '@trip/llm';
import { configureErrorDetail, correlationFields, isTracingInstalled, metrics, setupTracing } from '@trip/telemetry';
import pino, { type DestinationStream, type Logger } from 'pino';
import { mailerFromEnv, type Mailer } from './auth/mailer.js';
import { AuthService } from './auth/service.js';
import { loadEnv, type Env } from './env.js';
import { instrumentStore } from './infra/instrument-store.js';
import { buildInfrastructure, type SharedInfrastructure } from './infra/redis.js';
import { InMemoryRepository } from './repository/memory.js';
import type { Store } from './repository/store.js';
import { KnowledgeService } from './services/knowledge-service.js';
import { RunService } from './services/run-service.js';
import { RunWorker } from './worker/run-worker.js';

/**
 * The application container: one place that knows how the service is wired,
 * so routes receive their dependencies rather than reaching for globals and
 * tests can substitute any of them.
 */

export interface AppContext {
  env: Env;
  logger: Logger;
  registry: ProviderRegistry;
  llm: TripLlm;
  repository: Store;
  mailer: Mailer;
  auth: AuthService;
  runs: RunService;
  /** Built but not started: the entry point decides whether this process runs searches. */
  worker: RunWorker;
  /** Counters and cache shared between API processes (Redis), or this process's own when there is none. */
  infra: SharedInfrastructure;
  /** Answers from the curated knowledge index; null unless `KNOWLEDGE_ENABLED`. */
  knowledge: KnowledgeService | null;
}

/**
 * The service's logger. Exported so the way it redacts and what it writes about
 * a request can be tested as it really is, not as a test's own logger would.
 */
export function createLogger(
  env: Pick<Env, 'LOG_LEVEL'> & Partial<Pick<Env, 'NODE_ENV'>>,
  destination?: DestinationStream,
  service = 'trip-api',
): Logger {
  return pino(
    {
      level: env.LOG_LEVEL,
      // Every line carries the identifiers that tie it to a request, a run and a
      // trace (see `@trip/telemetry`): requestId, runId, tripId, traceId, spanId.
      // They come from the context the code is running in, so no call site
      // passes them, and there is one logging system, this one.
      mixin: () => correlationFields(),
      // Credentials, tokens, sign-in links, email addresses and traveller
      // documents must never reach a log line, and a redaction list is more
      // reliable than remembering at every call site. It is a second line of
      // defence: nothing that holds one is logged on purpose.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'req.headers["idempotency-key"]',
          'res.headers["set-cookie"]',
          'req.body',
          'body',
          // Top level, and one level down: pino's wildcard reaches one level only.
          'email',
          'to',
          'link',
          'token',
          'password',
          'secret',
          'apiKey',
          'clientSecret',
          'sessionSecret',
          'authorization',
          'cookie',
          '*.apiKey',
          '*.clientSecret',
          '*.password',
          '*.secret',
          '*.sessionSecret',
          '*.token',
          '*.link',
          '*.email',
          '*.to',
          '*.authorization',
          '*.cookie',
          '*.document',
          '*.document.number',
          'travelers[*].document',
        ],
        censor: '[redacted]',
      },
      // What is written about a request: its method, its path (never the query
      // string, which is where people put tokens), its id and the answer's
      // status. Not its headers, its body, its cookies or the caller's address.
      serializers: {
        req: (req: { method?: string; url?: string; id?: string }) => ({
          method: req.method,
          url: (req.url ?? '').split('?')[0],
          id: req.id,
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      },
      // Which process and environment a line came from. Lines from every process
      // share these names, so one query finds a problem across the API and workers.
      base: { service, env: env.NODE_ENV ?? 'development' },
    },
    destination,
  );
}

/** What a caller (in practice a test) may substitute for the parts the container builds itself. */
export interface ContextOverrides extends Partial<AppContext> {
  /** Stands in for the deterministic planning services, so a test can make a search slow or broken. */
  planningServices?: PlanningServices;
  /** Names this process in logs and traces (the worker passes `trip-worker`). */
  serviceName?: string;
}

export async function buildContext(overrides: ContextOverrides = {}): Promise<AppContext> {
  const env = overrides.env ?? loadEnv();

  const serviceName = overrides.serviceName ?? env.SERVICE_NAME ?? 'trip-api';
  configureErrorDetail(env.LOG_ERROR_MESSAGES);
  const logger = overrides.logger ?? createLogger(env, undefined, serviceName);

  // Tracing: spans exist (so logs carry trace ids) once this runs. They are
  // exported only if an OTLP endpoint is configured. A process that already has an
  // SDK installed (a test that installed an in-memory exporter) keeps it.
  if (env.TELEMETRY_ENABLED && !isTracingInstalled()) {
    await setupTracing({
      serviceName,
      environment: env.NODE_ENV,
      sampleRatio: env.OTEL_TRACES_SAMPLER_ARG,
      ...(env.OTEL_EXPORTER_OTLP_ENDPOINT ? { otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
    });
  }

  const infra = overrides.infra ?? buildInfrastructure(env, logger);
  const registry =
    overrides.registry ??
    ProviderRegistry.fromEnv(process.env, {
      ...(infra.cache ? { cacheStore: infra.cache } : {}),
      onPolicyEvent: (event) => logPolicyEvent(logger, event),
    });
  const llm = overrides.llm ?? llmFromEnv();

  let repository = overrides.repository;
  // Shared with the knowledge index, so there is one connection pool.
  let prismaClient: import('@prisma/client').PrismaClient | null = null;
  if (!repository) {
    if (env.DATABASE_URL) {
      // Imported lazily so a development run without a generated Prisma
      // client does not fail at startup.
      const { PrismaRepository } = await import('./repository/prisma.js');
      const prisma = PrismaRepository.fromUrl(env.DATABASE_URL);
      prismaClient = prisma.client;
      repository = prisma;
    } else {
      repository = new InMemoryRepository();
      logger.warn(
        'DATABASE_URL is not set: trips are held in memory and will be lost when this process exits.',
      );
    }
  }

  // Every store operation is timed (by name only, never by argument), and slow ones are counted and logged.
  repository = instrumentStore(repository, { slowMs: env.SLOW_DB_MS, logger });
  // The queue's depth is read when it is scraped, so it is never stale.
  const queueStore = repository;
  metrics.queueDepth.collectWith(async () => [{ value: await queueStore.countQueuedRuns() }]);

  const mailer = overrides.mailer ?? mailerFromEnv(env, logger);
  const auth = overrides.auth ?? new AuthService({ store: repository, env, mailer, logger });

  // The worker and the run service refer to each other only through `wake`:
  // queuing a run nudges an in-process worker to look for it now.
  let worker: RunWorker | null = null;
  const runs =
    overrides.runs ??
    new RunService({
      store: repository,
      registry,
      llm,
      env,
      logger,
      counters: infra.counters,
      ...(overrides.planningServices ? { planningServices: overrides.planningServices } : {}),
      onQueued: () => worker?.wake(),
    });
  worker = overrides.worker ?? new RunWorker({ store: repository, runs, env, logger });

  for (const disabled of registry.disabled) {
    logger.info({ provider: disabled.id, requires: disabled.requiredEnv }, disabled.reason);
  }
  if (!llm.available) {
    logger.info(
      'No LLM provider is configured. Conversational understanding falls back to deterministic rules; planning itself is unaffected because it never used the model.',
    );
  }

  const knowledge = overrides.knowledge !== undefined ? overrides.knowledge : await buildKnowledge(env, llm, prismaClient, logger);

  return { env, logger, registry, llm, repository, mailer, auth, runs, worker, infra, knowledge };
}

/**
 * The knowledge service, or null when it is not switched on. The index is the
 * PostgreSQL one when there is a database (sharing the repository's connection
 * pool), and an empty in-memory one otherwise: documents are ingested by a
 * script into the database, so without one there is nothing to answer from,
 * and the log says so.
 */
async function buildKnowledge(
  env: Env,
  llm: TripLlm,
  prisma: import('@prisma/client').PrismaClient | null,
  logger: Logger,
): Promise<KnowledgeService | null> {
  if (!env.KNOWLEDGE_ENABLED) return null;
  let store: KnowledgeStore;
  if (prisma) {
    const { PrismaKnowledgeStore } = await import('./repository/knowledge-prisma.js');
    store = new PrismaKnowledgeStore(prisma);
  } else {
    store = new InMemoryKnowledgeStore();
    logger.warn('KNOWLEDGE_ENABLED is set but there is no database: the knowledge index is empty, so every question will be answered "Insufficient verified information."');
  }
  const embedder = embedderFromEnv(process.env);
  logger.info({ namespace: env.KNOWLEDGE_NAMESPACE, embedder: embedder.space }, 'Knowledge answers are on');
  return new KnowledgeService({ store, embedder, model: llm, namespace: env.KNOWLEDGE_NAMESPACE, timeoutMs: env.KNOWLEDGE_TIMEOUT_MS, logger });
}

/** Circuit changes are worth a line; an ordinary skipped call is not. */
export function logPolicyEvent(logger: Logger, event: PolicyEvent): void {
  if (event.type === 'circuit') {
    const level = event.to === 'open' ? 'warn' : 'info';
    logger[level](// Not `from`/`to`: `to` is on the redaction list (it is where an email address goes), and a state name is not that.
    { operation: 'provider.circuit', circuit: event.key, fromState: event.from, toState: event.to }, `Provider circuit ${event.to.replace('_', ' ')}`);
  } else if (event.type === 'skipped') {
    logger.debug({ operation: 'provider.skipped', circuit: event.key, retryAfterMs: event.retryAfterMs }, 'Provider call skipped while its circuit is open');
  }
}
