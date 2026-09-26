import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * A monorepo keeps one `.env` at the root, but npm runs each workspace script
 * with that workspace as the working directory, so dotenv's default lookup
 * misses it. Walking up until a `.env` is found means `npm run dev -w @trip/api`
 * and `node apps/api/dist/index.js` both see the same configuration — and a
 * developer who set a key does not spend an hour wondering why it was ignored.
 */
function loadDotenvFromNearestRoot(): void {
  let dir = process.cwd();
  const { root } = parse(dir);
  while (true) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate });
      return;
    }
    if (dir === root) return;
    dir = dirname(dir);
  }
}

loadDotenvFromNearestRoot();

/**
 * Environment validation happens once, at boot, and fails loudly. A service
 * that starts with a half-configured environment and only discovers it on the
 * first traveller request is worse than one that refuses to start.
 *
 * Note what is *not* required: every travel provider credential is optional.
 * The system is designed to run with none of them and to say so.
 */

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  // `silent` is included for tests and for operators who ship logs from the
  // container runtime rather than the process.
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  /** Absent means the in-memory store, which is fine for local development. */
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),

  /** Comma-separated origins allowed to call the API from a browser. */
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  /** Signing secret for session tokens. Required outside development. */
  JWT_SECRET: z.string().min(32).optional(),

  RATE_LIMIT_MAX: z.coerce.number().int().default(120),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),

  /** Hard ceiling on a planning request, so a slow provider cannot hang a request. */
  PLANNING_TIMEOUT_MS: z.coerce.number().int().default(60_000),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/**
 * Parsing is cached for the process environment only. A caller that passes its
 * own source — a test, or a tool building a second configuration — gets a
 * fresh parse, because silently handing back the first one is the kind of
 * footgun that costs an afternoon.
 */
export function loadEnv(source?: NodeJS.ProcessEnv): Env {
  const explicit = source !== undefined;
  if (!explicit && cached) return cached;
  const parsed = EnvSchema.safeParse(source ?? process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  if (parsed.data.NODE_ENV === 'production') {
    if (!parsed.data.JWT_SECRET) {
      throw new Error('JWT_SECRET is required in production.');
    }
    if (!parsed.data.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is required in production. The in-memory store loses every trip on restart.',
      );
    }
  }
  if (!explicit) cached = parsed.data;
  return parsed.data;
}

export function corsOrigins(env: Env): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
