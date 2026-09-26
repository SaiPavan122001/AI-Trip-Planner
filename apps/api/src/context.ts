import { ProviderRegistry } from '@trip/providers';
import { llmFromEnv, type TripLlm } from '@trip/llm';
import pino, { type Logger } from 'pino';
import { mailerFromEnv, type Mailer } from './auth/mailer.js';
import { AuthService } from './auth/service.js';
import { loadEnv, type Env } from './env.js';
import { InMemoryRepository } from './repository/memory.js';
import type { Store } from './repository/store.js';
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
}

export async function buildContext(overrides: Partial<AppContext> = {}): Promise<AppContext> {
  const env = overrides.env ?? loadEnv();

  const logger =
    overrides.logger ??
    pino({
      level: env.LOG_LEVEL,
      // Credentials and traveller documents must never reach a log line, and
      // a redaction list is more reliable than remembering at every call site.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          '*.apiKey',
          '*.clientSecret',
          '*.password',
          '*.document',
          '*.document.number',
          'travelers[*].document',
        ],
        censor: '[redacted]',
      },
      base: { service: 'trip-api' },
    });

  const registry = overrides.registry ?? ProviderRegistry.fromEnv();
  const llm = overrides.llm ?? llmFromEnv();

  let repository = overrides.repository;
  if (!repository) {
    if (env.DATABASE_URL) {
      // Imported lazily so a development run without a generated Prisma
      // client does not fail at startup.
      const { PrismaRepository } = await import('./repository/prisma.js');
      repository = PrismaRepository.fromUrl(env.DATABASE_URL);
    } else {
      repository = new InMemoryRepository();
      logger.warn(
        'DATABASE_URL is not set: trips are held in memory and will be lost when this process exits.',
      );
    }
  }

  const mailer = overrides.mailer ?? mailerFromEnv(env, logger);
  const auth = overrides.auth ?? new AuthService({ store: repository, env, mailer, logger });

  // The worker and the run service refer to each other only through `wake`:
  // queuing a run nudges an in-process worker to look for it now.
  let worker: RunWorker | null = null;
  const runs =
    overrides.runs ??
    new RunService({ store: repository, registry, env, logger, onQueued: () => worker?.wake() });
  worker = overrides.worker ?? new RunWorker({ store: repository, runs, env, logger });

  for (const disabled of registry.disabled) {
    logger.info({ provider: disabled.id, requires: disabled.requiredEnv }, disabled.reason);
  }
  if (!llm.available) {
    logger.info(
      'No LLM provider is configured. Conversational understanding falls back to deterministic rules; planning itself is unaffected because it never used the model.',
    );
  }

  return { env, logger, registry, llm, repository, mailer, auth, runs, worker };
}
