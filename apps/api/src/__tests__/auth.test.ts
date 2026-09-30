import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DisabledMailer, MailDeliveryError } from '../auth/mailer.js';
import { hashToken, newToken } from '../auth/tokens.js';
import { TRIP_ID, buildTestApp, sessionFixture } from './helpers.js';
import { CapturingMailer, cookieFrom, newTripBody } from './test-kit.js';

/**
 * Who a request is from, and what they may touch: anonymous sessions, signing
 * in by emailed link, and the rule that a trip belongs to the person who made it.
 */

const withMailer = async (envVars: Record<string, string> = {}) => {
  const mailer = new CapturingMailer();
  const t = await buildTestApp({ mailer: mailer as never, geocoding: true, envVars });
  return { ...t, mailer };
};

const askForLink = (app: FastifyInstance, email: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email }, headers });

describe('anonymous sessions', () => {
  it('gives a first-time planner a private session, in a cookie JavaScript cannot read', async () => {
    const { bare } = await withMailer();
    const res = await bare.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody });

    expect(res.statusCode).toBe(201);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/^tp_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
  });

  it('remembers the person across requests, as someone who has not signed in', async () => {
    const { bare, repository } = await withMailer();
    const created = await bare.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody });
    const token = cookieFrom(created)!;

    const me = await bare.inject({ method: 'GET', url: '/v1/me', headers: { cookie: `tp_session=${token}` } });
    expect(me.json().user).toMatchObject({ email: null, isAnonymous: true });
    expect(me.json().tripCount).toBe(1);
    // The raw token is what the browser holds; the store keeps only a keyed
    // hash, so the token itself must not be found there.
    expect(await repository.findAuthSession(token, new Date())).toBeNull();
  });

  it('leaves nothing behind when a first request is refused', async () => {
    const { bare, repository } = await withMailer();
    const res = await bare.inject({
      method: 'POST',
      url: '/v1/trips',
      payload: { ...newTripBody, originQuery: 'Nowhereville' },
    });

    expect(res.statusCode).toBe(400);
    // The browser is told to hold no session, and the person made for the request is gone:
    // had one been left, housekeeping would find them once their session lapsed.
    expect(String(res.headers['set-cookie'])).toMatch(/^tp_session=;/);
    const later = await repository.sweepExpired(new Date(Date.now() + 40 * 24 * 3_600_000));
    expect(later.abandonedUsers).toBe(0);
  });

  it('does not create anyone just for looking', async () => {
    const { bare } = await withMailer();
    const me = await bare.inject({ method: 'GET', url: '/v1/me' });
    expect(me.json().user).toBeNull();
    expect(me.headers['set-cookie']).toBeUndefined();
    expect((await bare.inject({ method: 'GET', url: '/v1/trips' })).json().trips).toEqual([]);
  });

  it('ignores, and clears, a cookie that matches no session', async () => {
    const { bare } = await withMailer();
    const res = await bare.inject({ method: 'GET', url: '/v1/me', headers: { cookie: 'tp_session=not-a-real-token' } });
    expect(res.json().user).toBeNull();
    expect(String(res.headers['set-cookie'])).toMatch(/tp_session=;/);
  });

  it('does not accept an expired session', async () => {
    const { bare, repository, ctx } = await withMailer();
    const user = await repository.createUser({ email: null });
    const token = newToken();
    await repository.createAuthSession({
      userId: user.id,
      tokenHash: hashToken(ctx.env.sessionSecret, token),
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await bare.inject({ method: 'GET', url: '/v1/me', headers: { cookie: `tp_session=${token}` } });
    expect(res.json().user).toBeNull();
  });
});

describe('a trip belongs to the person who made it', () => {
  const routes: Array<[string, string, unknown?]> = [
    ['GET', `/v1/trips/${TRIP_ID}`],
    ['GET', `/v1/trips/${TRIP_ID}/question`],
    ['POST', `/v1/trips/${TRIP_ID}/answers`, { key: 'style.travel_style', value: 'premium' }],
    ['POST', `/v1/trips/${TRIP_ID}/plan`],
    ['POST', `/v1/trips/${TRIP_ID}/select`, { planId: 'x' }],
    ['PUT', `/v1/trips/${TRIP_ID}/pins`, { pins: [] }],
    ['POST', `/v1/trips/${TRIP_ID}/modify`, { utterance: 'make it cheaper' }],
    ['POST', `/v1/trips/${TRIP_ID}/modify/consent`, { pendingModificationId: TRIP_ID, accept: true }],
    ['GET', `/v1/trips/${TRIP_ID}/runs/${TRIP_ID}`],
    ['POST', `/v1/trips/${TRIP_ID}/runs/${TRIP_ID}/cancel`],
    ['DELETE', `/v1/trips/${TRIP_ID}`],
  ];

  it.each(routes)(
    '%s %s is "not found" for someone else, exactly as if it did not exist',
    async (method, url, payload) => {
      const { asStranger, repository } = await withMailer();
      const { app: stranger } = await asStranger();
      const before = await repository.getSession(TRIP_ID);
      const body = payload ? { payload: payload as object } : {};

      const res = await stranger.inject({ method: method as 'GET', url, ...body });
      const missing = await stranger.inject({
        method: method as 'GET',
        url: url.replace(TRIP_ID, '99999999-9999-4999-8999-999999999999'),
        ...body,
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
      expect(res.json()).toEqual(missing.json());
      // And nothing was changed or removed.
      expect(await repository.getSession(TRIP_ID)).toEqual(before);
    },
  );

  it('is not found for someone who is not signed in at all', async () => {
    const { bare } = await withMailer();
    expect((await bare.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}` })).statusCode).toBe(404);
    expect((await bare.inject({ method: 'DELETE', url: `/v1/trips/${TRIP_ID}` })).statusCode).toBe(404);
  });

  it('is not listed for someone else', async () => {
    const { app, asStranger } = await withMailer();
    const { app: stranger } = await asStranger();
    expect((await app.inject({ method: 'GET', url: '/v1/trips' })).json().trips).toHaveLength(1);
    expect((await stranger.inject({ method: 'GET', url: '/v1/trips' })).json().trips).toEqual([]);
  });

  it('is not reachable through a trip with no owner at all', async () => {
    const { app, repository } = await withMailer();
    const orphan = '22222222-2222-4222-8222-222222222222';
    await repository.createSession(sessionFixture(orphan, null));
    expect((await app.inject({ method: 'GET', url: `/v1/trips/${orphan}` })).statusCode).toBe(404);
  });
});

describe('signing in by emailed link', () => {
  it('emails a link that works once, and does not put it in the response', async () => {
    const { app, mailer } = await withMailer();
    const res = await askForLink(app, 'Ada@Example.com ');

    expect(res.statusCode).toBe(202);
    expect(JSON.stringify(res.json())).not.toContain(mailer.lastToken);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe('ada@example.com');
    expect(mailer.sent[0]!.link).toMatch(/^http:\/\/localhost:3000\/auth\/verify\?token=/);
  });

  it('answers the same for an address with an account and one without', async () => {
    const { app, repository } = await withMailer();
    await repository.createUser({ email: 'known@example.com' });
    const known = await askForLink(app, 'known@example.com');
    const unknown = await askForLink(app, 'new@example.com');
    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.json()).toEqual(unknown.json());
  });

  it('keeps an anonymous planner’s trips when they sign in', async () => {
    const { bare, mailer } = await withMailer();
    const created = await bare.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody });
    const anonCookie = `tp_session=${cookieFrom(created)!}`;
    const tripId = created.json().trip.id as string;

    await askForLink(bare, 'ada@example.com', { cookie: anonCookie });
    const verified = await bare.inject({
      method: 'POST',
      url: '/v1/auth/verify',
      payload: { token: mailer.lastToken },
      headers: { cookie: anonCookie },
    });

    expect(verified.statusCode).toBe(200);
    expect(verified.json().user).toMatchObject({ email: 'ada@example.com', isAnonymous: false });
    const signedIn = `tp_session=${cookieFrom(verified)!}`;
    // A new session: the browser does not keep the token it had before.
    expect(signedIn).not.toBe(anonCookie);
    const trip = await bare.inject({ method: 'GET', url: `/v1/trips/${tripId}`, headers: { cookie: signedIn } });
    expect(trip.statusCode).toBe(200);
    // The old cookie has been retired.
    const old = await bare.inject({ method: 'GET', url: '/v1/me', headers: { cookie: anonCookie } });
    expect(old.json().user).toBeNull();
  });

  it('moves trips into an account that already exists for that email', async () => {
    const { bare, mailer, repository } = await withMailer();
    const account = await repository.createUser({ email: 'ada@example.com' });
    const created = await bare.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody });
    const anonCookie = `tp_session=${cookieFrom(created)!}`;
    const tripId = created.json().trip.id as string;
    const me = await bare.inject({ method: 'GET', url: '/v1/me', headers: { cookie: anonCookie } });
    const anonUserId = me.json().user.id as string;

    await askForLink(bare, 'ada@example.com', { cookie: anonCookie });
    const verified = await bare.inject({
      method: 'POST',
      url: '/v1/auth/verify',
      payload: { token: mailer.lastToken },
      headers: { cookie: anonCookie },
    });

    expect(verified.json()).toMatchObject({ user: { id: account.id }, tripsMoved: 1 });
    expect((await repository.getSession(tripId))?.ownerId).toBe(account.id);
    expect(await repository.getUser(anonUserId)).toBeNull();
  });

  it('cannot be used a second time, even at the same instant', async () => {
    const { bare, mailer } = await withMailer();
    await askForLink(bare, 'ada@example.com');
    const token = mailer.lastToken;
    const results = await Promise.all([
      bare.inject({ method: 'POST', url: '/v1/auth/verify', payload: { token } }),
      bare.inject({ method: 'POST', url: '/v1/auth/verify', payload: { token } }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    const again = await bare.inject({ method: 'POST', url: '/v1/auth/verify', payload: { token } });
    expect(again.json().error.code).toBe('invalid_link');
  });

  it('refuses an expired link and one that was never issued, with the same answer', async () => {
    const { bare, repository, ctx } = await withMailer();
    const token = newToken();
    await repository.createLoginChallenge({
      email: 'ada@example.com',
      tokenHash: hashToken(ctx.env.sessionSecret, token),
      anonymousUserId: null,
      expiresAt: new Date(Date.now() - 1000),
    });
    const expired = await bare.inject({ method: 'POST', url: '/v1/auth/verify', payload: { token } });
    const unknown = await bare.inject({ method: 'POST', url: '/v1/auth/verify', payload: { token: 'nope' } });
    expect(expired.statusCode).toBe(400);
    expect(expired.json()).toEqual(unknown.json());
    expect((await bare.inject({ method: 'POST', url: '/v1/auth/verify', payload: {} })).statusCode).toBe(400);
  });

  it('limits how many links can be requested for one address', async () => {
    const { bare, mailer } = await withMailer({ MAGIC_LINK_MAX_PER_HOUR: '2' });
    expect((await askForLink(bare, 'ada@example.com')).statusCode).toBe(202);
    expect((await askForLink(bare, 'ada@example.com')).statusCode).toBe(202);
    const third = await askForLink(bare, 'ada@example.com');
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: { code: 'too_many_sign_in_emails' } });
    expect(mailer.sent).toHaveLength(2);
  });

  it('rejects something that is not an email address', async () => {
    const { bare, mailer } = await withMailer();
    for (const email of ['', 'not-an-email', 'a@b', `${'x'.repeat(300)}@example.com`, 42, null]) {
      expect((await askForLink(bare, email)).statusCode).toBe(400);
    }
    expect(mailer.sent).toHaveLength(0);
  });

  it('says so plainly when email cannot be sent, without leaking why', async () => {
    const { bare, mailer } = await withMailer();
    mailer.failWith = new MailDeliveryError('webhook http://mail.internal:9000 answered 500');
    const res = await askForLink(bare, 'ada@example.com');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'email_delivery_failed' } });
    expect(JSON.stringify(res.json())).not.toMatch(/internal|9000/);
  });

  it('says email sign-in is off when no mail is configured, and reports it in /v1/me', async () => {
    const { bare } = await buildTestApp({ mailer: new DisabledMailer() as never });
    const res = await askForLink(bare, 'ada@example.com');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'email_sign_in_unavailable' } });
    expect((await bare.inject({ method: 'GET', url: '/v1/me' })).json().emailSignIn).toBe(false);
  });

  it('signs out', async () => {
    const { app, bare, owner } = await withMailer();
    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout' });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/tp_session=;/);
    const after = await bare.inject({ method: 'GET', url: '/v1/me', headers: { cookie: owner.cookie } });
    expect(after.json().user).toBeNull();
  });
});

describe('requests from other sites', () => {
  it('refuses a change that comes from a site that is not ours', async () => {
    const { app } = await withMailer();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/trips/${TRIP_ID}/answers`,
      payload: { key: 'style.travel_style', value: 'premium' },
      headers: { origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('bad_origin');
  });

  it('allows our own web app, and reads from anywhere', async () => {
    const { app } = await withMailer();
    const own = await app.inject({
      method: 'POST',
      url: `/v1/trips/${TRIP_ID}/answers`,
      payload: { key: 'style.travel_style', value: 'premium' },
      headers: { origin: 'http://localhost:3000' },
    });
    expect(own.statusCode).toBe(200);
    const read = await app.inject({ method: 'GET', url: '/v1/me', headers: { origin: 'https://evil.example' } });
    expect(read.statusCode).toBe(200);
  });

  it('answers a browser’s preflight with credentials allowed only for our own origin', async () => {
    const { bare } = await withMailer();
    const ours = await bare.inject({
      method: 'OPTIONS',
      url: '/v1/trips',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST' },
    });
    expect(ours.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(ours.headers['access-control-allow-credentials']).toBe('true');
    const evil = await bare.inject({
      method: 'OPTIONS',
      url: '/v1/trips',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('the traveller’s control over their own data', () => {
  it('exports everything held about them', async () => {
    const { app } = await withMailer();
    const res = await app.inject({ method: 'GET', url: '/v1/me/export' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.json().trips.map((t: { id: string }) => t.id)).toEqual([TRIP_ID]);
  });

  it('needs a session to export', async () => {
    const { bare } = await withMailer();
    expect((await bare.inject({ method: 'GET', url: '/v1/me/export' })).statusCode).toBe(401);
  });

  it('deletes the account and every trip, only when asked to confirm', async () => {
    const { app, bare, repository, owner, asStranger } = await withMailer();
    const { user: other } = await asStranger();
    const theirs = await repository.createSession(sessionFixture('33333333-3333-4333-8333-333333333333', other.id));

    const unconfirmed = await app.inject({ method: 'DELETE', url: '/v1/me', payload: {} });
    expect(unconfirmed.statusCode).toBe(400);
    expect(await repository.getSession(TRIP_ID)).not.toBeNull();

    const res = await app.inject({ method: 'DELETE', url: '/v1/me', payload: { confirm: 'delete my account' } });
    expect(res.statusCode).toBe(204);
    expect(await repository.getSession(TRIP_ID)).toBeNull();
    expect(await repository.getUser(owner.id)).toBeNull();
    const after = await bare.inject({ method: 'GET', url: '/v1/me', headers: { cookie: owner.cookie } });
    expect(after.json().user).toBeNull();
    // Somebody else's data is not touched.
    expect(await repository.getSession(theirs.id)).not.toBeNull();
  });
});
