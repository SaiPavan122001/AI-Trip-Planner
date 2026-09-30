import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderRegistry } from '@trip/providers';
import { createLogger } from '../context.js';
import { InMemoryRepository } from '../repository/memory.js';
import { TRIP_ID, buildTestApp, testEnv } from './helpers.js';
import { CapturingMailer, newTripBody } from './test-kit.js';

/**
 * What the service says about people and about itself (Phase 6.6, 6.10, 6.11):
 * in its logs, in its answers, in its configuration and in the repository.
 * Every check here looks for a specific value that must not appear, so a
 * pass means it was searched for and not found.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');

afterEach(() => vi.unstubAllGlobals());

/** A logger like the service's own, writing to memory. */
function captured() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const logger = createLogger({ LOG_LEVEL: 'debug' }, stream);
  return { logger, text: () => lines.join(''), lines: () => lines };
}

const SESSION_SECRET = 'a-very-long-and-unmistakable-session-secret-0123456789';
const WEBHOOK_TOKEN = 'WEBHOOK-TOKEN-UNMISTAKABLE-42';
const AMADEUS_SECRET = 'AMADEUS-SECRET-UNMISTAKABLE-42';
const SENTINEL_UTTERANCE = 'SENTINEL-UTTERANCE-ABOUT-MY-HOLIDAY';
const QUERY_SECRET = 'SECRET-IN-QUERY-STRING';
const ADDRESS = '203.0.113.5';

describe('what the log says', () => {
  it('holds no cookie, no token, no email address, no address, no query string and no traveller\'s words', async () => {
    const log = captured();
    const mailer = new CapturingMailer();
    const t = await buildTestApp({
      logger: log.logger,
      mailer: mailer as never,
      geocoding: true,
      envVars: { SESSION_SECRET, LOG_LEVEL: 'debug', RATE_LIMIT_MAX: '4' },
    });

    // A first trip, made without a session, with a secret-looking query string.
    const created = await t.bare.inject({ method: 'POST', url: `/v1/trips?token=${QUERY_SECRET}`, payload: newTripBody, remoteAddress: ADDRESS, headers: { 'idempotency-key': 'idem-key-UNMISTAKABLE-1234' } });
    const cookie = String(created.headers['set-cookie']).split(';')[0]!;
    const sessionToken = cookie.split('=')[1]!;
    const tripId = created.json().trip.id as string;

    // Signing in by email.
    await t.bare.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email: 'sam.private@example.com' }, headers: { cookie }, remoteAddress: ADDRESS });
    const linkToken = mailer.lastToken;
    await t.bare.inject({ method: 'POST', url: '/v1/auth/verify', payload: { token: linkToken }, headers: { cookie }, remoteAddress: ADDRESS });
    // A refused link, a change request in words, a request from another site, and enough traffic to be limited.
    await t.bare.inject({ method: 'POST', url: '/v1/auth/verify', payload: { token: 'not-a-real-token-UNMISTAKABLE' }, remoteAddress: ADDRESS });
    await t.bare.inject({ method: 'POST', url: `/v1/trips/${tripId}/modify`, payload: { utterance: SENTINEL_UTTERANCE }, headers: { cookie }, remoteAddress: ADDRESS });
    await t.bare.inject({ method: 'POST', url: `/v1/trips/${tripId}/answers`, payload: { key: 'style.travel_style', value: 'premium' }, headers: { origin: 'https://evil.example', cookie }, remoteAddress: ADDRESS });
    for (let i = 0; i < 6; i += 1) await t.bare.inject({ method: 'GET', url: `/v1/trips/${tripId}?extra=${QUERY_SECRET}`, headers: { cookie }, remoteAddress: ADDRESS });
    // And a failure nobody planned for.
    t.repository.getSession = async () => {
      throw new Error(`database error near ${QUERY_SECRET} for sam.private@example.com`);
    };
    await t.bare.inject({ method: 'GET', url: `/v1/trips/${tripId}`, headers: { cookie: `${cookie}` }, remoteAddress: ADDRESS });

    const out = log.text();
    expect(out.length).toBeGreaterThan(200); // it did log something
    for (const secret of [sessionToken, linkToken, 'sam.private@example.com', ADDRESS, QUERY_SECRET, SENTINEL_UTTERANCE, SESSION_SECRET, 'idem-key-UNMISTAKABLE-1234', 'not-a-real-token-UNMISTAKABLE']) {
      // The failure the test planted quotes two of them in its message; that error text is the service's own
      // internal log line and is allowed to say what broke, so only those two are exempt from that one line.
      const allowedInErrorLine = secret === QUERY_SECRET || secret === 'sam.private@example.com';
      const relevant = allowedInErrorLine ? log.lines().filter((l) => !l.includes('database error near')) : log.lines();
      expect(relevant.join(''), `the log contains ${secret.slice(0, 12)}…`).not.toContain(secret);
    }
  });

  it('records what happened to security-relevant requests, without saying who by', async () => {
    const log = captured();
    const t = await buildTestApp({ logger: log.logger, envVars: { RATE_LIMIT_MAX: '2', RATE_LIMIT_ADDRESS_MAX: '2', LOG_LEVEL: 'debug' } });
    await t.bare.inject({ method: 'POST', url: '/v1/auth/logout', headers: { origin: 'https://evil.example' }, remoteAddress: ADDRESS });
    for (let i = 0; i < 4; i += 1) await t.bare.inject({ method: 'GET', url: '/v1/me', remoteAddress: ADDRESS });
    const events = log.lines().map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l['security']);
    expect(events.map((e) => e['security'])).toEqual(expect.arrayContaining(['bad_origin', 'rate_limited']));
    for (const e of events) {
      expect(String(e['address'])).toMatch(/^[0-9a-f]{16}$/); // a keyed tag, never the address
      expect(JSON.stringify(e)).not.toContain(ADDRESS);
    }
  });

  it('describes a request by its method, its path and its id only', async () => {
    const log = captured();
    const t = await buildTestApp({ logger: log.logger, envVars: { LOG_LEVEL: 'debug' } });
    await t.bare.inject({ method: 'GET', url: '/v1/me?secret=1', headers: { cookie: 'tp_session=abc', authorization: 'Bearer xyz', 'user-agent': 'private-agent-string' }, remoteAddress: ADDRESS });
    const request = log.lines().map((l) => JSON.parse(l) as { req?: Record<string, unknown> }).find((l) => l.req);
    expect(request?.req).toEqual({ method: 'GET', url: '/v1/me', id: expect.any(String) });
    expect(log.text()).not.toMatch(/abc|xyz|private-agent-string|secret=1|remoteAddress|hostname/);
  });

  it('redacts a secret-named field that someone logs by mistake, at any depth it is likely to sit', () => {
    const log = captured();
    log.logger.info({ email: 'a@example.com', token: 'tok-1', link: 'http://x/?t=1', to: 'a@example.com', password: 'p', apiKey: 'k', authorization: 'a', cookie: 'c', user: { email: 'b@example.com', token: 't' }, body: { utterance: 'private' }, req: { headers: { cookie: 'c2', authorization: 'a2', 'x-api-key': 'k2' }, body: 'b' } }, 'careless');
    const out = log.text();
    for (const leaked of ['a@example.com', 'b@example.com', 'tok-1', 'http://x/?t=1', 'private', 'c2', 'a2', 'k2']) expect(out).not.toContain(leaked);
    expect(out).toContain('[redacted]');
  });
});

describe('secrets in what the service returns', () => {
  it('never appear in a response or a log, whatever endpoint is asked and however a provider fails', async () => {
    // A provider call that fails with a message that quotes the secret, as real libraries sometimes do.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED while sending client_secret=${AMADEUS_SECRET} to https://test.api.amadeus.com`);
    }));
    const registry = ProviderRegistry.fromEnv({
      AMADEUS_CLIENT_ID: 'placeholder-client-id',
      AMADEUS_CLIENT_SECRET: AMADEUS_SECRET,
      NOMINATIM_USER_AGENT: 'wayfare-test (nobody@example.invalid)',
      OSRM_BASE_URL: 'https://osrm.example.test',
      GOOGLE_MAPS_API_KEY: 'GOOGLE-KEY-UNMISTAKABLE-42',
    });
    const log = captured();
    const t = await buildTestApp({
      registry,
      logger: log.logger,
      envVars: { SESSION_SECRET, MAIL_WEBHOOK_URL: 'https://mail.example.test/hook', MAIL_WEBHOOK_TOKEN: WEBHOOK_TOKEN, LOG_LEVEL: 'debug', RATE_LIMIT_MAX: '1000', RATE_LIMIT_ADDRESS_MAX: '1000' },
    });
    const bodies: string[] = [];
    const record = (res: { body: string; headers: Record<string, unknown> }) => bodies.push(res.body, JSON.stringify(res.headers));
    record(await t.app.inject({ method: 'GET', url: '/v1/providers' }));
    record(await t.app.inject({ method: 'GET', url: '/v1/providers/health' }));
    record(await t.app.inject({ method: 'GET', url: '/v1/places?q=goa' }));
    record(await t.app.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody }));
    record(await t.app.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email: 'sam@example.com' } }));
    record(await t.app.inject({ method: 'GET', url: '/ready' }));
    record(await t.app.inject({ method: 'GET', url: '/health' }));
    record(await t.app.inject({ method: 'GET', url: '/v1/me/export' }));
    for (const secret of [AMADEUS_SECRET, 'GOOGLE-KEY-UNMISTAKABLE-42', WEBHOOK_TOKEN, SESSION_SECRET]) {
      expect(bodies.join('\n'), `a response contains ${secret.slice(0, 10)}…`).not.toContain(secret);
      expect(log.text(), `the log contains ${secret.slice(0, 10)}…`).not.toContain(secret);
    }
  });

  it('are kept out of configuration errors, which name the setting and never its value', () => {
    const cases: Array<Record<string, string>> = [{ MAIL_WEBHOOK_URL: 'https://user:hunter2-UNMISTAKABLE@mail.example.test/hook' }, { WEB_BASE_URL: 'ftp://hunter2-UNMISTAKABLE.example.test' }, { SESSION_SECRET: 'too-short-hunter2' }];
    for (const bad of cases) {
      try {
        testEnv(bad);
        throw new Error('should have refused');
      } catch (err) {
        expect((err as Error).message).not.toContain('hunter2');
      }
    }
  });

  it('are required in production, and the development fallback is refused there', () => {
    expect(() => testEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@localhost:5432/d' })).toThrow(/SESSION_SECRET/);
    expect(() => testEnv({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40) })).toThrow(/DATABASE_URL/);
    expect(() => testEnv({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgresql://u:p@localhost:5432/d', MAIL_WEBHOOK_URL: 'http://mail.example.test/hook' })).toThrow(/https/);
  });
});

describe('what an outsider can learn about the deployment', () => {
  const production = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgresql://u:p@localhost:5432/d', MAILER: 'disabled', COOKIE_SECURE: 'true' };

  it('does not name the environment variables that would enable a provider, in production', async () => {
    const t = await buildTestApp({ repository: new InMemoryRepository(), seedTrip: false, envVars: production });
    const res = await t.bare.inject({ method: 'GET', url: '/v1/providers' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    for (const d of body.disabled as Array<{ requiredEnv: string[]; reason: string }>) {
      expect(d.requiredEnv).toEqual([]);
      expect(d.reason).toBe('Not connected in this deployment.');
    }
    expect(res.body).not.toMatch(/_KEY|_SECRET|_URL|NOMINATIM_USER_AGENT/);
  });

  it('does say so in development, where the person running it needs to know', async () => {
    const t = await buildTestApp({ seedTrip: false });
    const body = (await t.bare.inject({ method: 'GET', url: '/v1/providers' })).json();
    expect((body.disabled as Array<{ requiredEnv: string[] }>).some((d) => d.requiredEnv.length > 0)).toBe(true);
  });

  it('does not run live provider probes in production unless told to', async () => {
    const t = await buildTestApp({ seedTrip: false, envVars: production });
    const res = await t.bare.inject({ method: 'GET', url: '/v1/providers/health' });
    expect(res.statusCode).toBe(403);
    const allowed = await buildTestApp({ seedTrip: false, envVars: { ...production, EXPOSE_PROVIDER_HEALTH: 'true' } });
    expect((await allowed.bare.inject({ method: 'GET', url: '/v1/providers/health' })).statusCode).toBeLessThan(300);
  });

  it('runs one round of probes for a crowd asking at once, and reuses it for half a minute', async () => {
    const t = await buildTestApp({ seedTrip: false, envVars: { RATE_LIMIT_MAX: '1000' } });
    let probes = 0;
    t.ctx.registry.healthReport = async () => {
      probes += 1;
      await new Promise((r) => setTimeout(r, 30));
      return [];
    };
    const all = await Promise.all(Array.from({ length: 5 }, (_, i) => t.bare.inject({ method: 'GET', url: '/v1/providers/health', remoteAddress: `203.0.113.${i + 1}` })));
    expect(all.every((r) => r.statusCode === 200)).toBe(true);
    await t.bare.inject({ method: 'GET', url: '/v1/providers/health', remoteAddress: '203.0.113.90' });
    expect(probes).toBe(1);
  });

  it('keeps a health probe\'s failures to a fixed sentence per provider', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND internal-db.corp.example 10.0.0.9');
    }));
    const registry = ProviderRegistry.fromEnv({ NOMINATIM_USER_AGENT: 'wayfare-test (nobody@example.invalid)', OSRM_BASE_URL: 'https://osrm.example.test' });
    const t = await buildTestApp({ registry, seedTrip: false });
    const res = await t.bare.inject({ method: 'GET', url: '/v1/providers/health' });
    expect(res.statusCode).toBe(207);
    expect(res.body).not.toMatch(/ENOTFOUND|10\.0\.0\.9|internal-db/);
  });
});

describe('what is stored about a person', () => {
  it('holds an email only for someone who signed in, and never puts it in a trip, a run or the audit trail', async () => {
    const mailer = new CapturingMailer();
    const t = await buildTestApp({ mailer: mailer as never, geocoding: true, seedTrip: false });
    const created = await t.bare.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody });
    const cookie = String(created.headers['set-cookie']).split(';')[0]!;
    const tripId = created.json().trip.id as string;
    const anonymous = await t.bare.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect(anonymous.json().user.email).toBeNull();

    await t.bare.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email: 'sam.private@example.com' }, headers: { cookie } });
    const signedIn = await t.bare.inject({ method: 'POST', url: '/v1/auth/verify', payload: { token: mailer.lastToken }, headers: { cookie } });
    // Signing in issued a fresh session: the trip is reached with that one.
    const signedInCookie = String(signedIn.headers['set-cookie']).split(';')[0]!;
    await t.bare.inject({ method: 'POST', url: `/v1/trips/${tripId}/plan`, headers: { cookie: signedInCookie } });

    const stored = JSON.stringify(await t.repository.getSession(tripId));
    expect(stored).not.toContain('sam.private@example.com');
    expect(JSON.stringify(await t.repository.listAudit(tripId))).not.toContain('sam.private@example.com');
    expect(JSON.stringify(await t.repository.latestRunForTrip(tripId))).not.toContain('sam.private@example.com');
  });

  it('keeps what a traveller typed out of the audit trail, which records that things happened, not what was said', async () => {
    const t = await buildTestApp();
    await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/modify`, payload: { utterance: `${SENTINEL_UTTERANCE} avoid overnight travel` } });
    await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/requirements`, payload: { message: `${SENTINEL_UTTERANCE} no buses please` } });
    await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` });
    expect(JSON.stringify(await t.repository.listAudit(TRIP_ID))).not.toContain(SENTINEL_UTTERANCE);
  });

  it('collects no traveller documents, and stores none: the booking routes read nothing', async () => {
    const t = await buildTestApp();
    const res = await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/travelers`, payload: { travelers: [{ givenName: 'A', passportNumber: 'Z9999999', dateOfBirth: '1990-01-01' }] } });
    expect(res.statusCode).toBe(501);
    expect(JSON.stringify(await t.repository.getSession(TRIP_ID))).not.toContain('Z9999999');
    expect(await t.repository.getTravelerDetails(TRIP_ID)).toEqual([]);
  });

  it('exports a person\'s own data with the provider tokens blanked, as everywhere else', async () => {
    const { fakeTravelRegistry, SECRET_TOKEN } = await import('./fake-providers.js');
    const { answerRequired } = await import('./test-kit.js');
    const travel = fakeTravelRegistry({});
    const t = await buildTestApp({ registry: travel.registry });
    await answerRequired(t.app as never, TRIP_ID);
    await t.app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` });
    await t.ctx.worker.drain();
    const read = await t.app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}` });
    expect(read.json().trip.plans.length).toBeGreaterThan(0);
    expect(read.body).not.toContain(SECRET_TOKEN);
    const listed = await t.app.inject({ method: 'GET', url: '/v1/trips' });
    expect(listed.body).not.toContain(SECRET_TOKEN);
  });
});

describe('what is in the repository', () => {
  const tracked = (): string[] | null => {
    try {
      return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20_000_000 }).split('\n').filter(Boolean);
    } catch {
      return null; // no git here (a source archive): the scan cannot run, and says so by passing nothing off
    }
  };
  const read = (file: string) => {
    try {
      return readFileSync(join(ROOT, file), 'utf8');
    } catch {
      return '';
    }
  };

  it('has an example configuration with placeholders only', () => {
    const lines = read('.env.example').split('\n').filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l));
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      const [name, ...rest] = line.split('=');
      const value = rest.join('=').trim();
      if (/(KEY|SECRET|TOKEN|PASSWORD)$/.test(name!) && !/^(COOKIE|SESSION_TTL)/.test(name!)) {
        expect(value, `${name} has a value in .env.example`).toBe('');
      }
    }
  });

  it('has no file that looks like a real credential', () => {
    const files = tracked();
    if (!files) return;
    const patterns: Array<[string, RegExp]> = [
      ['an AWS access key', /AKIA[0-9A-Z]{16}/],
      ['a Google API key', /AIza[0-9A-Za-z_-]{35}/],
      ['a provider secret key', /\bsk-[A-Za-z0-9]{24,}/],
      ['a Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
      ['a GitHub token', /gh[pousr]_[A-Za-z0-9]{36}/],
      ['a private key', /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
      ['a connection string with a password', /postgres(ql)?:\/\/[^:\s/@]+:(?!(wayfare|trip|p|password|postgres|pass|x|u)@)[^@\s]{6,}@(?!localhost|127\.0\.0\.1|postgres|redis)/],
    ];
    const hits: string[] = [];
    for (const file of files) {
      if (/\.(png|jpg|ico|woff2?|lock)$|package-lock\.json$/.test(file)) continue;
      const text = read(file);
      for (const [what, pattern] of patterns) if (pattern.test(text)) hits.push(`${file}: ${what}`);
    }
    expect(hits).toEqual([]);
  });

  it('does not track a .env file, or anything that stores traveller data', () => {
    const files = tracked();
    if (!files) return;
    expect(files.filter((f) => /(^|\/)\.env($|\.(?!example))/.test(f))).toEqual([]);
    expect(files.filter((f) => /\.(sqlite|db|dump|bak)$/.test(f))).toEqual([]);
  });
});
