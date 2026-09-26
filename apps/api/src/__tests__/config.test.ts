import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { mailerFromEnv } from '../auth/mailer.js';
import { loadEnv, trustProxyOption } from '../env.js';
import { canonicalJson, inputsHash } from '../util/canonical.js';
import { publicView } from '../util/public.js';
import { sessionFixture } from './helpers.js';

const silent = pino({ level: 'silent' });

/** The same data with every object's keys in the opposite order. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)]));
  }
  return value;
}
const production = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@db:5432/trip',
  SESSION_SECRET: 's'.repeat(40),
};

describe('configuration', () => {
  it('refuses to start in production without a session secret or a database', () => {
    expect(() => loadEnv({ ...production, SESSION_SECRET: undefined })).toThrow(/SESSION_SECRET is required/);
    expect(() => loadEnv({ ...production, DATABASE_URL: undefined })).toThrow(/DATABASE_URL is required/);
  });

  it('accepts JWT_SECRET as the old name for the session secret', () => {
    const env = loadEnv({ ...production, SESSION_SECRET: undefined, JWT_SECRET: 'j'.repeat(40) });
    expect(env.sessionSecret).toBe('j'.repeat(40));
  });

  it('rejects a secret too short to protect anything', () => {
    expect(() => loadEnv({ ...production, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  it('marks cookies secure in production, and not in development', () => {
    expect(loadEnv(production).COOKIE_SECURE).toBe(true);
    expect(loadEnv({ NODE_ENV: 'development' }).COOKIE_SECURE).toBe(false);
    expect(loadEnv({ ...production, COOKIE_SECURE: 'false' }).COOKIE_SECURE).toBe(false);
  });

  it('will not ask for cookies browsers reject', () => {
    expect(() => loadEnv({ NODE_ENV: 'development', COOKIE_SAMESITE: 'none' })).toThrow(/COOKIE_SECURE/);
    expect(loadEnv({ NODE_ENV: 'development', COOKIE_SAMESITE: 'none', COOKIE_SECURE: 'true' }).COOKIE_SAMESITE).toBe('none');
  });

  it('does not print sign-in links to a production log', () => {
    expect(() => mailerFromEnv(loadEnv({ ...production, MAILER: 'console' }), silent)).toThrow(/not allowed in production/);
    expect(mailerFromEnv(loadEnv(production), silent).kind).toBe('disabled');
    expect(mailerFromEnv(loadEnv({ ...production, MAIL_WEBHOOK_URL: 'https://mail.example/send' }), silent).kind).toBe('webhook');
    expect(mailerFromEnv(loadEnv({ NODE_ENV: 'development' }), silent).kind).toBe('console');
    expect(() => mailerFromEnv(loadEnv({ NODE_ENV: 'development', MAILER: 'webhook' }), silent)).toThrow(/MAIL_WEBHOOK_URL/);
  });

  it('reads TRUST_PROXY as none, all, a number of hops, or a list', () => {
    const opt = (v?: string) => trustProxyOption(loadEnv({ NODE_ENV: 'test', ...(v === undefined ? {} : { TRUST_PROXY: v }) }));
    expect(opt()).toBe(false);
    expect(opt('false')).toBe(false);
    expect(opt('true')).toBe(true);
    expect(opt('10.0.0.0/8, 127.0.0.1')).toEqual(['10.0.0.0/8', '127.0.0.1']);
    const hops = opt('1') as (address: string, hop: number) => boolean;
    expect([hops('x', 0), hops('x', 1)]).toEqual([true, false]);
  });
});

describe('what a search is fingerprinted by', () => {
  it('gives the same fingerprint however the keys were ordered, as after a trip through JSONB', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [3, { x: 2, y: 1 }] }, b: 1 }));
    const session = sessionFixture();
    const reordered = reverseKeys(session) as typeof session;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(session));
    expect(inputsHash(reordered)).toBe(inputsHash(session));
  });

  it('changes when anything the search depends on changes, and only then', () => {
    const base = sessionFixture();
    const hash = inputsHash(base);
    expect(inputsHash({ ...base, intent: { ...base.intent, departureDate: '2030-12-01' } })).not.toBe(hash);
    expect(inputsHash({ ...base, profile: { ...base.profile, travelStyle: 'premium' } })).not.toBe(hash);
    expect(inputsHash({ ...base, pins: ['hotel'] })).not.toBe(hash);
    // Pin order does not matter; things that do not affect a search do not count.
    expect(inputsHash({ ...base, pins: ['hotel', 'outbound'] })).toBe(inputsHash({ ...base, pins: ['outbound', 'hotel'] }));
    const noisy = { ...base, version: 9, updatedAt: '2031-01-01T00:00:00.000Z', decisionLog: [] };
    expect(inputsHash(noisy)).toBe(hash);
  });
});

describe('what leaves the server', () => {
  it('blanks revalidation tokens wherever they are, and leaves everything else alone', () => {
    const out = publicView({ a: { revalidationToken: 'SECRET', keep: 1 }, list: [{ revalidationToken: 'SECRET' }, 'x'], n: null });
    expect(JSON.stringify(out)).not.toContain('SECRET');
    expect(out).toEqual({ a: { revalidationToken: null, keep: 1 }, list: [{ revalidationToken: null }, 'x'], n: null });
  });
});
