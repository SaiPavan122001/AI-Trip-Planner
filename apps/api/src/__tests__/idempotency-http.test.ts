import { describe, expect, it } from 'vitest';
import { TRIP_ID, buildTestApp, signedInUser } from './helpers.js';
import { CapturingMailer, newTripBody } from './test-kit.js';

/**
 * Idempotency over HTTP (Phase 5.5): a request that carries an
 * `Idempotency-Key` is carried out once, however many times it arrives, and
 * never on behalf of, or against, anyone else's.
 */

const key = (suffix = 'a') => `test-key-${suffix}-0123456789`;
const withKey = (k: string) => ({ 'idempotency-key': k });

async function tripCount(repository: { listSessions: (o: string, n: number) => Promise<unknown[]> }, owner: string) {
  return (await repository.listSessions(owner, 50)).length;
}

describe('creating a trip', () => {
  it('without a key, is not deduplicated: two requests are two trips (the safeguard is opt-in)', async () => {
    const { app, repository, owner } = await buildTestApp({ geocoding: true, seedTrip: false });
    await app.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody });
    await app.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody });
    expect(await tripCount(repository, owner.id)).toBe(2);
  });

  it('with a key, a repeat gets the first answer back and makes nothing', async () => {
    const { app, repository, owner } = await buildTestApp({ geocoding: true, seedTrip: false });
    const first = await app.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody, headers: withKey(key()) });
    const again = await app.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody, headers: withKey(key()) });
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(201);
    expect(again.json().trip.id).toBe(first.json().trip.id);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(first.headers['idempotent-replay']).toBeUndefined();
    expect(await tripCount(repository, owner.id)).toBe(1);
  });

  it('with the same key and a different request, refuses both ways round', async () => {
    const { app, repository, owner } = await buildTestApp({ geocoding: true, seedTrip: false });
    await app.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody, headers: withKey(key()) });
    const different = await app.inject({
      method: 'POST',
      url: '/v1/trips',
      payload: { ...newTripBody, destinationQuery: 'Mysuru' },
      headers: withKey(key()),
    });
    expect(different.statusCode).toBe(422);
    expect(different.json().error.code).toBe('idempotency_key_reused');
    expect(await tripCount(repository, owner.id)).toBe(1);
  });

  it('keeps one person\'s key from touching another\'s: the same key is a different claim for each', async () => {
    const { app, asStranger, repository, owner } = await buildTestApp({ geocoding: true, seedTrip: false });
    const mine = await app.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody, headers: withKey(key()) });
    const { app: theirs, user } = await asStranger();
    const also = await theirs.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody, headers: withKey(key()) });
    expect(also.statusCode).toBe(201);
    expect(also.headers['idempotent-replay']).toBeUndefined(); // not a replay of mine
    expect(also.json().trip.id).not.toBe(mine.json().trip.id);
    expect(also.json().trip.ownerId).toBe(user.id);
    expect(await tripCount(repository, owner.id)).toBe(1);
  });

  it('runs once when the same request arrives many times at the same moment', async () => {
    const { app, repository, owner } = await buildTestApp({ geocoding: true, seedTrip: false });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => app.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody, headers: withKey(key('race')) })),
    );
    const codes = results.map((r) => r.statusCode);
    // One did the work; each of the others either waited (409, ask again) or arrived after and got the answer back.
    expect(codes.every((c) => c === 201 || c === 409)).toBe(true);
    expect(codes.filter((c) => c === 201).length).toBeGreaterThanOrEqual(1);
    for (const r of results.filter((x) => x.statusCode === 409)) {
      expect(r.json().error.code).toBe('idempotency_in_progress');
      expect(r.headers['retry-after']).toBeDefined();
    }
    expect(await tripCount(repository, owner.id)).toBe(1);
    const ids = new Set(results.filter((r) => r.statusCode === 201).map((r) => r.json().trip.id));
    expect(ids.size).toBe(1);
  });

  it('lets a request that failed be tried again with the same key', async () => {
    const { app, repository, owner } = await buildTestApp({ geocoding: true, seedTrip: false });
    const bad = await app.inject({ method: 'POST', url: '/v1/trips', payload: { ...newTripBody, originQuery: 'Nowhereville' }, headers: withKey(key()) });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    const good = await app.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody, headers: withKey(key()) });
    expect(good.statusCode).toBe(201);
    expect(await tripCount(repository, owner.id)).toBe(1);
  });

  it('still answers when the answer cannot be remembered', async () => {
    const { app, repository } = await buildTestApp({ geocoding: true, seedTrip: false });
    repository.completeIdempotencyKey = async () => {
      throw new Error('database is unavailable');
    };
    const res = await app.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody, headers: withKey(key()) });
    expect(res.statusCode).toBe(201);
  });
});

describe('the key itself', () => {
  it.each(['short', 'has spaces in it right here', 'x'.repeat(129), 'bad/slash/characters/here', '<script>alert(1)</script>'])('refuses "%s"', async (bad) => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan`, headers: withKey(bad) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('is ignored on a read: repeating a GET does no harm, so there is nothing to protect', async () => {
    const { app } = await buildTestApp();
    const a = await app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}`, headers: withKey(key()) });
    const b = await app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}`, headers: withKey(key()) });
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(b.headers['idempotent-replay']).toBeUndefined();
  });
});

describe('starting a search', () => {
  it('with a key, a repeat returns the first answer, and one search exists', async () => {
    const { app, repository } = await buildTestApp();
    const first = await app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan`, headers: withKey(key()) });
    const again = await app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan`, headers: withKey(key()) });
    expect(first.statusCode).toBe(202);
    expect(again.statusCode).toBe(202);
    expect(again.json().run.id).toBe(first.json().run.id);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect((await repository.latestRunForTrip(TRIP_ID))?.id).toBe(first.json().run.id);
  });

  it('with no key, a repeat while one is running still starts nothing, and says it reused it', async () => {
    const { app } = await buildTestApp();
    const first = await app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` });
    const again = await app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` });
    expect(again.json().run.id).toBe(first.json().run.id);
    expect(again.json().reused).toBe(true);
  });

  it('starts one search when ten requests arrive together', async () => {
    const { app, repository } = await buildTestApp({ envVars: { RATE_LIMIT_MAX: '1000', MAX_ACTIVE_RUNS_PER_USER: '5' } });
    const results = await Promise.all(Array.from({ length: 10 }, () => app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` })));
    expect(results.every((r) => r.statusCode === 202)).toBe(true);
    expect(new Set(results.map((r) => r.json().run.id)).size).toBe(1);
    const active = await repository.countActiveRunsForOwner((await repository.getSession(TRIP_ID))!.ownerId!);
    expect(active).toBe(1);
  });
});

describe('cancelling', () => {
  it('is safe to repeat, with or without a key', async () => {
    const { app } = await buildTestApp();
    const started = (await app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/plan` })).json().run as { id: string };
    const url = `/v1/trips/${TRIP_ID}/runs/${started.id}/cancel`;
    const first = await app.inject({ method: 'POST', url, headers: withKey(key()) });
    const again = await app.inject({ method: 'POST', url, headers: withKey(key()) });
    const bare = await app.inject({ method: 'POST', url });
    expect([first.statusCode, again.statusCode, bare.statusCode]).toEqual([202, 202, 202]);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(bare.json().run.status).toBe('cancelled');
  });
});

describe('a change request', () => {
  it('is applied once however often the same keyed request arrives', async () => {
    const { app, repository } = await buildTestApp();
    const send = () => app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/modify`, payload: { utterance: 'avoid overnight travel' }, headers: withKey(key('mod')) });
    const first = await send();
    const logAfterFirst = (await repository.getSession(TRIP_ID))!.decisionLog.length;
    const again = await send();
    const logAfterSecond = (await repository.getSession(TRIP_ID))!.decisionLog.length;
    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(logAfterFirst).toBeGreaterThan(0); // the first request did change the trip
    expect(logAfterSecond).toBe(logAfterFirst); // the repeat did not
  });

  it('is applied every time when sent without a key (the baseline the key improves on)', async () => {
    const { app, repository } = await buildTestApp();
    const send = () => app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/modify`, payload: { utterance: 'avoid overnight travel' } });
    await send();
    const one = (await repository.getSession(TRIP_ID))!.decisionLog.length;
    await send();
    expect((await repository.getSession(TRIP_ID))!.decisionLog.length).toBeGreaterThan(one);
  });
});

describe('asking for a sign-in email', () => {
  it('sends one email for a repeated keyed request', async () => {
    const mailer = new CapturingMailer();
    const { bare } = await buildTestApp({ mailer, seedTrip: false });
    const send = () => bare.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email: 'sam@example.com' }, headers: withKey(key('mail')) });
    const first = await send();
    const again = await send();
    expect([first.statusCode, again.statusCode]).toEqual([202, 202]);
    expect(mailer.sent).toHaveLength(1);
  });

  it('refuses the same key for a different address rather than sending to either without saying', async () => {
    const mailer = new CapturingMailer();
    const { bare } = await buildTestApp({ mailer, seedTrip: false });
    await bare.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email: 'sam@example.com' }, headers: withKey(key('mail')) });
    const other = await bare.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { email: 'someone.else@example.com' }, headers: withKey(key('mail')) });
    expect(other.statusCode).toBe(422);
    expect(mailer.sent).toHaveLength(1);
  });
});

describe('a person and their claims', () => {
  it('a claim made by an anonymous person is theirs only', async () => {
    const { bare, repository, ctx } = await buildTestApp({ geocoding: true, seedTrip: false });
    const a = await signedInUser(repository, ctx.env);
    const b = await signedInUser(repository, ctx.env);
    const send = (cookie: string) => bare.inject({ method: 'POST', url: '/v1/trips', payload: newTripBody, headers: { cookie, ...withKey(key('own')) } });
    const first = await send(a.cookie);
    const second = await send(b.cookie);
    expect(first.json().trip.ownerId).toBe(a.id);
    expect(second.json().trip.ownerId).toBe(b.id);
  });
});
