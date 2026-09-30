import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { AuthService } from '../auth/service.js';
import { TRIP_ID, buildTestApp, signedInUser, testEnv } from './helpers.js';
import { CapturingMailer, cookieFrom, newTripBody } from './test-kit.js';

/**
 * Authentication (Phase 6.2): sessions end, can be revoked, and cannot be
 * used to probe for accounts or to make the service look up tokens without
 * limit. Where the existing tests cover a property, this file adds to them
 * rather than repeating them.
 */

const DAY = 86_400_000;

describe('a session has a limited life', () => {
  it('ends a fixed time after it began, however often it was used in between', async () => {
    // A clock the test moves. Renewal on use keeps a session going for its 30-day
    // life again and again; without an absolute limit, it never ended.
    // The in-memory store stamps sessions with the real clock, so the test's clock starts there and moves forward.
    const start = Date.now();
    let now = new Date(start);
    const mailer = new CapturingMailer();
    const env = testEnv({ SESSION_MAX_DAYS: '90', SESSION_TTL_DAYS: '30' });
    const first = await buildTestApp({ env, mailer: mailer as never, seedTrip: false });
    const auth = new AuthService({ store: first.repository, env, mailer: mailer as never, logger: pino({ level: 'silent' }), now: () => now });
    const { app } = await buildTestApp({ env, repository: first.repository, mailer: mailer as never, auth, seedTrip: false });

    // Signs in with a session created "now".
    const started = await auth.startAnonymous();
    const cookie = `${env.COOKIE_NAME}=${started.session.token}`;
    const me = () => app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect((await me()).json().user).not.toBeNull();

    // Used every twenty days, so it is renewed each time and never idle for its 30.
    for (const day of [20, 40, 60, 80]) {
      now = new Date(start + day * DAY);
      expect((await me()).json().user).not.toBeNull();
    }
    // Day 100: the renewed session would still be valid for another 10 days, but it is 100 days old.
    now = new Date(start + 100 * DAY);
    const res = await me();
    expect(res.json().user).toBeNull();
    // And it is gone, not merely refused: the cookie is cleared and the session deleted.
    expect(String(res.headers['set-cookie'])).toMatch(/tp_session=;/);
    expect(await first.repository.findAuthSession(auth['hash'](started.session.token), now)).toBeNull();
  });
});

describe('signing out', () => {
  it('ends the session that was used, and only that one', async () => {
    const t = await buildTestApp();
    const second = await signedInUser(t.repository, t.ctx.env);
    const out = await t.app.inject({ method: 'POST', url: '/v1/auth/logout' });
    expect(out.statusCode).toBe(204);
    expect((await t.bare.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}`, headers: { cookie: t.owner.cookie } })).statusCode).toBe(404);
    // Someone else's session is untouched.
    expect((await t.bare.inject({ method: 'GET', url: '/v1/me', headers: { cookie: second.cookie } })).json().user).not.toBeNull();
  });

  it('ends every session of the person on every device, for a lost phone or a cookie that leaked', async () => {
    const t = await buildTestApp();
    // The same person on a second device: another session for the same user.
    const { hashToken, newToken } = await import('../auth/tokens.js');
    const laptop = newToken();
    await t.repository.createAuthSession({ userId: t.owner.id, tokenHash: hashToken(t.ctx.env.sessionSecret, laptop), expiresAt: new Date(Date.now() + 30 * DAY) });
    const laptopCookie = `${t.ctx.env.COOKIE_NAME}=${laptop}`;
    expect((await t.bare.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}`, headers: { cookie: laptopCookie } })).statusCode).toBe(200);

    const out = await t.app.inject({ method: 'POST', url: '/v1/auth/logout-all' });
    expect(out.statusCode).toBe(204);
    for (const cookie of [t.owner.cookie, laptopCookie]) {
      expect((await t.bare.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}`, headers: { cookie } })).statusCode).toBe(404);
    }
    // The trip itself is untouched: signing out is not deleting.
    expect(await t.repository.getSession(TRIP_ID)).not.toBeNull();
  });
});

describe('guessing sign-in links', () => {
  const verify = (t: Awaited<ReturnType<typeof buildTestApp>>, token: string, remoteAddress = '203.0.113.50') =>
    t.bare.inject({ method: 'POST', url: '/v1/auth/verify', payload: { token }, remoteAddress });

  it('locks an address out after a run of refused links, with a time to come back', async () => {
    const t = await buildTestApp({ seedTrip: false });
    const answers: number[] = [];
    for (let i = 0; i < 12; i += 1) answers.push((await verify(t, `wrong-token-${i}`)).statusCode);
    // Eight refusals are allowed; after that the lookups stop.
    expect(answers.slice(0, 8)).toEqual(Array(8).fill(400));
    expect(answers.slice(8)).toEqual(Array(4).fill(429));
    const locked = await verify(t, 'another-wrong-one');
    expect(locked.json().error.code).toBe('too_many_failed_sign_ins');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('does not reach the store for a locked address, so guessing costs the service nothing', async () => {
    const t = await buildTestApp({ seedTrip: false });
    for (let i = 0; i < 8; i += 1) await verify(t, `wrong-${i}`);
    let lookups = 0;
    const original = t.repository.consumeLoginChallenge.bind(t.repository);
    t.repository.consumeLoginChallenge = async (...args) => (lookups += 1, original(...args));
    for (let i = 0; i < 20; i += 1) await verify(t, `guess-${i}`);
    expect(lookups).toBe(0);
  });

  it('leaves other addresses alone, and a genuine link still works from an address that has not been guessing', async () => {
    const mailer = new CapturingMailer();
    const t = await buildTestApp({ mailer: mailer as never, seedTrip: false });
    for (let i = 0; i < 9; i += 1) await verify(t, `wrong-${i}`, '203.0.113.50');
    await t.bare.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email: 'sam@example.com' } });
    const ok = await verify(t, mailer.lastToken, '203.0.113.99');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.email).toBe('sam@example.com');
    // The locked address is refused even with a real link: it must wait, like anyone that has been guessing.
    await t.bare.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email: 'sam@example.com' }, remoteAddress: '203.0.113.99' });
    expect((await verify(t, mailer.lastToken, '203.0.113.50')).statusCode).toBe(429);
  });

  it('says the same thing whatever was wrong with a link, so its state cannot be learned', async () => {
    const mailer = new CapturingMailer();
    const t = await buildTestApp({ mailer: mailer as never, seedTrip: false });
    await t.bare.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email: 'sam@example.com' } });
    const token = mailer.lastToken;
    await verify(t, token, '203.0.113.60'); // used
    const used = await verify(t, token, '203.0.113.61');
    const never = await verify(t, 'never-issued-token', '203.0.113.62');
    const junk = await verify(t, 'x'.repeat(500), '203.0.113.63');
    for (const r of [used, never, junk]) expect(r.statusCode).toBe(400);
    expect(used.body).toBe(never.body);
    expect(never.body).toBe(junk.body);
  });

  it('does not take a token from anywhere but the body', async () => {
    const mailer = new CapturingMailer();
    const t = await buildTestApp({ mailer: mailer as never, seedTrip: false });
    await t.bare.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email: 'sam@example.com' } });
    const viaQuery = await t.bare.inject({ method: 'POST', url: `/v1/auth/verify?token=${mailer.lastToken}`, payload: {} });
    expect(viaQuery.statusCode).toBe(400);
    const viaGet = await t.bare.inject({ method: 'GET', url: `/v1/auth/verify?token=${mailer.lastToken}` });
    expect(viaGet.statusCode).toBe(404);
    expect((await t.bare.inject({ method: 'POST', url: '/v1/auth/verify', payload: { token: mailer.lastToken } })).statusCode).toBe(200); // still unused
  });
});

describe('every sign-in issues a fresh session', () => {
  it('replaces the cookie the browser had before it proved who it was (no session fixation)', async () => {
    const mailer = new CapturingMailer();
    const t = await buildTestApp({ mailer: mailer as never, geocoding: true, seedTrip: false });
    const created = await t.bare.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody });
    const before = cookieFrom(created)!;
    await t.bare.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email: 'sam@example.com' }, headers: { cookie: `tp_session=${before}` } });
    const signedIn = await t.bare.inject({ method: 'POST', url: '/v1/auth/verify', payload: { token: mailer.lastToken }, headers: { cookie: `tp_session=${before}` } });
    const after = cookieFrom(signedIn)!;
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    // The old token no longer works: an attacker who planted it gets nothing.
    expect((await t.bare.inject({ method: 'GET', url: '/v1/me', headers: { cookie: `tp_session=${before}` } })).json().user).toBeNull();
  });
});

describe('the session cookie', () => {
  it('is HttpOnly, SameSite, scoped to the whole site, and never contains anything about the person', async () => {
    const t = await buildTestApp({ geocoding: true, seedTrip: false });
    const res = await t.bare.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody });
    const header = String(res.headers['set-cookie']);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    const token = cookieFrom(res)!;
    // 256 random bits, base64url: nothing in it to decode.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const me = (await t.bare.inject({ method: 'GET', url: '/v1/me', headers: { cookie: `tp_session=${token}` } })).json();
    expect(token).not.toContain(me.user.id);
  });

  it('is Secure when the service runs in production, and refuses SameSite=None without it', () => {
    const production = testEnv({ NODE_ENV: 'production', SESSION_SECRET: 's'.repeat(40), DATABASE_URL: 'postgresql://u:p@localhost:5432/d', MAILER: 'disabled' });
    expect(production.COOKIE_SECURE).toBe(true);
    expect(() => testEnv({ COOKIE_SAMESITE: 'none', COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
  });

  it('is stored only as a keyed hash, so a copy of the database cannot be used to sign in', async () => {
    const t = await buildTestApp();
    const token = t.owner.cookie.split('=')[1]!;
    const found = await t.repository.findAuthSession(token, new Date()); // the raw token is not what is stored
    expect(found).toBeNull();
  });
});

describe('asking for sign-in emails', () => {
  it('cannot be used to fill someone\'s inbox: a limit per recipient, whoever asks', async () => {
    const mailer = new CapturingMailer();
    const t = await buildTestApp({ mailer: mailer as never, seedTrip: false, envVars: { MAGIC_LINK_MAX_PER_HOUR: '3', RATE_LIMIT_MAX: '1000', RATE_LIMIT_ADDRESS_MAX: '1000' } });
    const codes: number[] = [];
    // Ten different callers, ten addresses, one victim.
    for (let i = 0; i < 10; i += 1) {
      codes.push((await t.bare.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email: 'victim@example.com' }, remoteAddress: `198.51.100.${i + 1}` })).statusCode);
    }
    expect(codes.filter((c) => c === 202)).toHaveLength(3);
    expect(mailer.sent.filter((m) => m.to === 'victim@example.com')).toHaveLength(3);
  });

  it('cannot be used to send a great many emails from one address to different recipients', async () => {
    const mailer = new CapturingMailer();
    const t = await buildTestApp({ mailer: mailer as never, seedTrip: false, envVars: { RATE_LIMIT_MAX: '1000', RATE_LIMIT_ADDRESS_MAX: '1000' } });
    const codes: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      codes.push((await t.bare.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email: `person${i}@example.com` }, remoteAddress: '203.0.113.77' })).statusCode);
    }
    expect(codes.filter((c) => c === 202)).toHaveLength(30); // the hourly ceiling for an address
    expect(codes.filter((c) => c === 429)).toHaveLength(10);
  });

  it('refuses headers and control characters in an address, so nothing can be injected into the message', async () => {
    const mailer = new CapturingMailer();
    const t = await buildTestApp({ mailer: mailer as never, seedTrip: false });
    for (const email of ['a@example.com\r\nBcc: victim@example.com', 'a@example.com,b@example.com', 'a b@example.com', '<script>@example.com', 'a@example.com\u0000']) {
      const res = await t.bare.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email } });
      expect(res.statusCode).toBe(400);
    }
    expect(mailer.sent).toHaveLength(0);
  });
});
