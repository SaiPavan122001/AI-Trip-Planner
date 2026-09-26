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

/** "true" / "false" from an environment variable; anything else is a mistake worth failing on. */
const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

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

  /**
   * Keys the hash of every sign-in token before it is stored, so a copy of the
   * database cannot be used to sign in. Required in production. `JWT_SECRET`
   * is accepted under its old name.
   */
  SESSION_SECRET: z.string().min(32).optional(),
  JWT_SECRET: z.string().min(32).optional(),
  COOKIE_NAME: z.string().default('tp_session'),
  /** Defaults to on in production, where cookies must only travel over HTTPS. */
  COOKIE_SECURE: flag.optional(),
  /** Use `none` (with COOKIE_SECURE) only if the web app and API are on unrelated sites. */
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_DOMAIN: z.string().optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  /** Where the web app lives; sign-in links point here. */
  WEB_BASE_URL: z.string().url().default('http://localhost:3000'),
  /**
   * How sign-in links are delivered: `console` logs them (development),
   * `webhook` posts them to MAIL_WEBHOOK_URL, `disabled` turns email sign-in
   * off. Unset means webhook if a URL is given, console outside production,
   * and disabled in production.
   */
  MAILER: z.enum(['console', 'webhook', 'disabled']).optional(),
  MAIL_WEBHOOK_URL: z.string().url().optional(),
  MAIL_WEBHOOK_TOKEN: z.string().optional(),
  MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
  MAGIC_LINK_MAX_PER_HOUR: z.coerce.number().int().min(1).max(50).default(5),

  /**
   * Which proxies to believe about the client's address: `false` (none),
   * `true` (any), a number of hops, or a comma-separated list of addresses.
   * Wrong in either direction is a problem: too trusting lets anyone pick
   * their own rate-limit identity; too strict rate-limits everyone as one.
   */
  TRUST_PROXY: z.string().default('false'),

  RATE_LIMIT_MAX: z.coerce.number().int().default(120),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),

  /** Hard ceiling on one planning run, so a slow provider cannot hold a worker. */
  PLANNING_TIMEOUT_MS: z.coerce.number().int().default(60_000),

  /** Run background searches inside this process. Turn off where a separate worker runs them. */
  RUN_WORKER: flag.default('true'),
  RUN_LEASE_MS: z.coerce.number().int().min(1000).default(30_000),
  RUN_POLL_MS: z.coerce.number().int().min(50).default(1000),
  RUN_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  RUN_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  /** Searches a person may start per day; each one calls paid provider APIs. */
  PLAN_RUNS_PER_DAY_ANONYMOUS: z.coerce.number().int().min(1).default(15),
  PLAN_RUNS_PER_DAY_SIGNED_IN: z.coerce.number().int().min(1).default(60),
});

export type Env = Omit<z.infer<typeof EnvSchema>, 'COOKIE_SECURE'> & {
  COOKIE_SECURE: boolean;
  /** SESSION_SECRET, or JWT_SECRET under its old name. Always set outside development. */
  sessionSecret: string;
};

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
  const production = parsed.data.NODE_ENV === 'production';
  const secret = parsed.data.SESSION_SECRET ?? parsed.data.JWT_SECRET;
  if (production) {
    if (!secret) {
      throw new Error('SESSION_SECRET is required in production (at least 32 characters).');
    }
    if (!parsed.data.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is required in production. The in-memory store loses every trip on restart.',
      );
    }
  }
  const secure = parsed.data.COOKIE_SECURE ?? production;
  if (parsed.data.COOKIE_SAMESITE === 'none' && !secure) {
    throw new Error('COOKIE_SAMESITE=none needs COOKIE_SECURE=true: browsers reject the cookie otherwise.');
  }
  const env: Env = {
    ...parsed.data,
    COOKIE_SECURE: secure,
    // Outside production a fixed development secret keeps sign-in working
    // with no setup. It is public, so it is never accepted in production.
    sessionSecret: secret ?? 'development-only-session-secret-not-for-production',
  };
  if (!explicit) cached = env;
  return env;
}

/**
 * The value Fastify's `trustProxy` option takes for a TRUST_PROXY setting. A
 * number of hops becomes a function that believes that many proxies.
 */
export function trustProxyOption(env: Env): boolean | string[] | ((address: string, hop: number) => boolean) {
  const raw = env.TRUST_PROXY.trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false' || raw === '') return false;
  if (/^[0-9]+$/.test(raw)) {
    const hops = Number(raw);
    return (_address, hop) => hop < hops;
  }
  return env.TRUST_PROXY.split(',').map((a) => a.trim()).filter(Boolean);
}

export function corsOrigins(env: Env): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
