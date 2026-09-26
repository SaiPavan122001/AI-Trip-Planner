import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PlanningSession } from '@trip/shared';
import type { Store } from '../../repository/store.js';
import { EmailTakenError } from '../../repository/store.js';
import { TripChangedError } from '../../repository/types.js';
import { sessionFixture } from '../helpers.js';

/**
 * What every store must do, written once and run against both the in-memory
 * store and PostgreSQL. The in-memory store is what most tests and local
 * development use; the point of running the same cases against a real
 * database is that "it behaves like PostgreSQL" is checked, not assumed.
 */

export interface StoreHarness {
  store: Store;
  /** Empties every table between tests. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hours = (n: number) => new Date(Date.now() + n * 3_600_000);

export function describeStoreContract(name: string, open: () => Promise<StoreHarness>): void {
  describe(`${name} store`, () => {
    let harness: StoreHarness;
    let store: Store;

    const newTrip = async (ownerId: string | null, patch: Partial<PlanningSession> = {}) =>
      store.createSession({ ...sessionFixture(randomUUID()), ownerId, ...patch });

    const newUser = (email: string | null = null) => store.createUser({ email });

    const run = (tripId: string, ownerId: string | null = null) => ({
      tripId,
      ownerId,
      kind: 'plan' as const,
      inputsHash: 'h1',
      baseVersion: 0,
      params: { keep: {} },
    });

    const enqueued = async (tripId: string, ownerId: string | null = null) => {
      const res = await store.enqueueRun(run(tripId, ownerId));
      if (!('run' in res)) throw new Error('expected a new run');
      return res.run;
    };

    harness = undefined as unknown as StoreHarness;
    beforeEach(async () => {
      harness ??= await open();
      await harness.reset();
      store = harness.store;
    });
    afterAll(async () => {
      await harness?.close();
    });

    // ------------------------------------------------------------- trips

    describe('trips and optimistic locking', () => {
      it('stores a new trip at version 0 and reads it back', async () => {
        const user = await newUser();
        const created = await newTrip(user.id);
        expect(created.version).toBe(0);
        expect(await store.getSession(created.id)).toEqual(created);
      });

      it('increments the version on every save', async () => {
        const user = await newUser();
        const v0 = await newTrip(user.id);
        const v1 = await store.updateSession({ ...v0, stage: 'profiling' });
        const v2 = await store.updateSession(v1);
        expect([v1.version, v2.version]).toEqual([1, 2]);
        expect((await store.getSession(v0.id))?.version).toBe(2);
      });

      it('refuses a save made from an out-of-date read, and changes nothing', async () => {
        const user = await newUser();
        const v0 = await newTrip(user.id);
        await store.updateSession({ ...v0, stage: 'searching' });

        await expect(store.updateSession({ ...v0, stage: 'planned' })).rejects.toBeInstanceOf(TripChangedError);
        expect((await store.getSession(v0.id))?.stage).toBe('searching');
      });

      it('lets exactly one of two simultaneous saves win', async () => {
        const user = await newUser();
        const v0 = await newTrip(user.id);
        const results = await Promise.allSettled([
          store.updateSession({ ...v0, stage: 'searching' }),
          store.updateSession({ ...v0, stage: 'planned' }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
        expect((await store.getSession(v0.id))?.version).toBe(1);
      });

      it('treats a save to a trip that was deleted as a conflict', async () => {
        const user = await newUser();
        const v0 = await newTrip(user.id);
        await store.deleteSession(v0.id);
        await expect(store.updateSession(v0)).rejects.toBeInstanceOf(TripChangedError);
      });

      it('lists only the owner’s trips, newest first, up to the limit', async () => {
        const [a, b] = [await newUser(), await newUser()];
        const first = await newTrip(a.id);
        await sleep(15);
        const second = await newTrip(a.id);
        await newTrip(b.id);
        await sleep(15);
        await store.updateSession(first);

        const mine = await store.listSessions(a.id, 10);
        expect(mine.map((t) => t.id)).toEqual([first.id, second.id]);
        expect(await store.listSessions(a.id, 1)).toHaveLength(1);
        expect(await store.listSessions(randomUUID(), 10)).toEqual([]);
      });

      it('keeps pins and the last search with the trip', async () => {
        const user = await newUser();
        const created = await newTrip(user.id);
        const saved = await store.updateSession({
          ...created,
          pins: ['hotel'],
          lastSearch: {
            builtAt: '2026-01-01T00:00:00.000Z',
            outbound: { date: '2026-11-10', modes: [] },
            inbound: null,
            hotelsConsidered: 3,
            hotelsFiltered: [],
            budgetConflict: null,
          },
        });
        const read = await store.getSession(saved.id);
        expect(read?.pins).toEqual(['hotel']);
        expect(read?.lastSearch?.hotelsConsidered).toBe(3);
      });

      it('deletes a trip with its runs and audit trail', async () => {
        const user = await newUser();
        const trip = await newTrip(user.id);
        const queued = await enqueued(trip.id, user.id);
        await store.recordAudit({ tripId: trip.id, kind: 'trip.created', actor: user.id, detail: {} });

        await store.deleteSession(trip.id);

        expect(await store.getSession(trip.id)).toBeNull();
        expect(await store.getRun(queued.id)).toBeNull();
        expect(await store.listAudit(trip.id)).toEqual([]);
      });
    });

    // -------------------------------------------------------------- runs

    describe('planning runs', () => {
      it('queues a run, and returns the active one instead of a second', async () => {
        const trip = await newTrip(null);
        const first = await store.enqueueRun(run(trip.id));
        expect('run' in first && first.run.status).toBe('queued');

        const second = await store.enqueueRun(run(trip.id));
        expect('active' in second && second.active.id).toBe('run' in first ? first.run.id : null);
      });

      it('creates exactly one run when several are queued at once', async () => {
        const trip = await newTrip(null);
        const results = await Promise.all(Array.from({ length: 5 }, () => store.enqueueRun(run(trip.id))));
        expect(results.filter((r) => 'run' in r)).toHaveLength(1);
        expect(results.filter((r) => 'active' in r)).toHaveLength(4);
      });

      it('allows a new run once the earlier one is over', async () => {
        const trip = await newTrip(null);
        const first = await enqueued(trip.id);
        const claimed = await store.claimRun('w1', 60_000, 3);
        expect(claimed?.id).toBe(first.id);
        expect(await store.finishRun(first.id, 'w1', 'succeeded')).toBe(true);

        const next = await store.enqueueRun(run(trip.id));
        expect('run' in next).toBe(true);
        expect((await store.latestRunForTrip(trip.id))?.id).toBe('run' in next ? next.run.id : '');
      });

      it('hands the oldest queued run to a worker and marks it running', async () => {
        const [t1, t2] = [await newTrip(null), await newTrip(null)];
        const older = await enqueued(t1.id);
        await sleep(15);
        await enqueued(t2.id);

        const claimed = await store.claimRun('w1', 60_000, 3);
        expect(claimed?.id).toBe(older.id);
        expect(claimed).toMatchObject({ status: 'running', workerId: 'w1', attempts: 1 });
        expect(claimed?.startedAt).not.toBeNull();
        expect((await store.activeRunForTrip(t1.id))?.status).toBe('running');
      });

      it('never gives the same run to two workers', async () => {
        const trip = await newTrip(null);
        await enqueued(trip.id);
        const claims = await Promise.all(Array.from({ length: 6 }, (_, i) => store.claimRun(`w${i}`, 60_000, 3)));
        expect(claims.filter(Boolean)).toHaveLength(1);
      });

      it('gives different runs to workers that ask at the same time', async () => {
        const trips = await Promise.all([newTrip(null), newTrip(null), newTrip(null)]);
        await Promise.all(trips.map((t) => enqueued(t.id)));
        const claims = await Promise.all(Array.from({ length: 3 }, (_, i) => store.claimRun(`w${i}`, 60_000, 3)));
        expect(new Set(claims.map((c) => c?.id)).size).toBe(3);
        expect(await store.claimRun('w9', 60_000, 3)).toBeNull();
      });

      it('does not hand out a run whose lease is still good, but does once it lapses', async () => {
        const trip = await newTrip(null);
        const queued = await enqueued(trip.id);
        await store.claimRun('w1', 80, 3);
        expect(await store.claimRun('w2', 60_000, 3)).toBeNull();

        await sleep(200);
        const retaken = await store.claimRun('w2', 60_000, 3);
        expect(retaken).toMatchObject({ id: queued.id, workerId: 'w2', attempts: 2 });
        // The first worker has lost the run: it can no longer renew or finish it.
        expect((await store.heartbeatRun(queued.id, 'w1', 1000)).owned).toBe(false);
        expect(await store.finishRun(queued.id, 'w1', 'succeeded')).toBe(false);
      });

      it('stops handing out a run that has used all its attempts, and reaping fails it', async () => {
        const trip = await newTrip(null);
        const queued = await enqueued(trip.id);
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          expect(await store.claimRun('w', 40, 2)).not.toBeNull();
          await sleep(120);
        }
        expect(await store.claimRun('w', 60_000, 2)).toBeNull();

        expect(await store.reapRuns(2)).toBe(1);
        const after = await store.getRun(queued.id);
        expect(after?.status).toBe('failed');
        expect(after?.error?.code).toBe('interrupted');
        // A failed run no longer blocks the trip.
        expect('run' in (await store.enqueueRun(run(trip.id)))).toBe(true);
      });

      it('renews a lease and records progress on a heartbeat', async () => {
        const trip = await newTrip(null);
        const queued = await enqueued(trip.id);
        await store.claimRun('w1', 80, 3);

        const beat = await store.heartbeatRun(queued.id, 'w1', 60_000, {
          step: 'flights',
          label: 'Searching flights',
          percent: 30,
        });
        expect(beat).toEqual({ owned: true, cancelRequested: false });
        await sleep(200);
        // Renewed, so it has not lapsed.
        expect(await store.claimRun('w2', 60_000, 3)).toBeNull();
        expect((await store.getRun(queued.id))?.progress).toEqual({
          step: 'flights',
          label: 'Searching flights',
          percent: 30,
        });
      });

      it('only lets the worker holding a run finish it, and only once', async () => {
        const trip = await newTrip(null);
        const queued = await enqueued(trip.id);
        await store.claimRun('w1', 60_000, 3);

        expect(await store.finishRun(queued.id, 'someone-else', 'succeeded')).toBe(false);
        expect(await store.finishRun(queued.id, 'w1', 'failed', { code: 'x', message: 'boom' })).toBe(true);
        expect(await store.finishRun(queued.id, 'w1', 'succeeded')).toBe(false);
        expect(await store.getRun(queued.id)).toMatchObject({
          status: 'failed',
          error: { code: 'x', message: 'boom' },
        });
      });

      it('cancels a queued run at once, and asks a running one to stop', async () => {
        const [t1, t2] = [await newTrip(null), await newTrip(null)];
        const waiting = await enqueued(t1.id);
        expect((await store.requestCancel(waiting.id))?.status).toBe('cancelled');
        expect(await store.claimRun('w1', 60_000, 3)).toBeNull();

        const working = await enqueued(t2.id);
        await store.claimRun('w1', 60_000, 3);
        const asked = await store.requestCancel(working.id);
        expect(asked).toMatchObject({ status: 'running', cancelRequested: true });
        expect(await store.heartbeatRun(working.id, 'w1', 60_000)).toEqual({ owned: true, cancelRequested: true });
        expect(await store.finishRun(working.id, 'w1', 'cancelled')).toBe(true);
        expect(await store.requestCancel(randomUUID())).toBeNull();
      });

      it('cancels a lapsed run the traveller had asked to stop', async () => {
        const trip = await newTrip(null);
        const queued = await enqueued(trip.id);
        await store.claimRun('w1', 40, 3);
        await store.requestCancel(queued.id);
        await sleep(120);
        expect(await store.reapRuns(3)).toBe(1);
        expect((await store.getRun(queued.id))?.status).toBe('cancelled');
      });

      it('counts a person’s runs since a moment, for daily limits', async () => {
        const user = await newUser();
        const [t1, t2] = [await newTrip(user.id), await newTrip(user.id)];
        await enqueued(t1.id, user.id);
        await enqueued(t2.id, user.id);
        expect(await store.countRunsSince(user.id, hours(-1))).toBe(2);
        expect(await store.countRunsSince(user.id, hours(1))).toBe(0);
        expect(await store.countRunsSince(randomUUID(), hours(-1))).toBe(0);
      });
    });

    // ---------------------------------------------------------- identity

    describe('people and sign-in', () => {
      it('creates people with or without an email, and finds them by it', async () => {
        const anon = await newUser();
        const known = await newUser('ada@example.com');
        expect(anon.email).toBeNull();
        expect((await store.getUserByEmail('ada@example.com'))?.id).toBe(known.id);
        expect(await store.getUserByEmail('nobody@example.com')).toBeNull();
        expect((await store.getUser(anon.id))?.id).toBe(anon.id);
      });

      it('keeps an email to one person', async () => {
        await newUser('ada@example.com');
        await expect(newUser('ada@example.com')).rejects.toBeInstanceOf(EmailTakenError);
        const other = await newUser();
        await expect(store.setUserEmail(other.id, 'ada@example.com')).rejects.toBeInstanceOf(EmailTakenError);
        expect((await store.setUserEmail(other.id, 'grace@example.com')).email).toBe('grace@example.com');
      });

      it('finds a live sign-in by its token hash, and not an expired or revoked one', async () => {
        const user = await newUser();
        const live = await store.createAuthSession({ userId: user.id, tokenHash: 'live', expiresAt: hours(1) });
        await store.createAuthSession({ userId: user.id, tokenHash: 'expired', expiresAt: hours(-1) });

        const found = await store.findAuthSession('live', new Date());
        expect(found?.user.id).toBe(user.id);
        expect(await store.findAuthSession('expired', new Date())).toBeNull();
        expect(await store.findAuthSession('unknown', new Date())).toBeNull();

        await store.revokeAuthSession(live.id);
        expect(await store.findAuthSession('live', new Date())).toBeNull();
      });

      it('extends a sign-in when it is used', async () => {
        const user = await newUser();
        const session = await store.createAuthSession({ userId: user.id, tokenHash: 't', expiresAt: hours(1) });
        await store.touchAuthSession(session.id, new Date(), hours(24));
        const found = await store.findAuthSession('t', new Date());
        expect(Date.parse(found!.session.expiresAt)).toBeGreaterThan(Date.now() + 20 * 3_600_000);
      });

      it('signs a person out everywhere', async () => {
        const user = await newUser();
        await store.createAuthSession({ userId: user.id, tokenHash: 'a', expiresAt: hours(1) });
        await store.createAuthSession({ userId: user.id, tokenHash: 'b', expiresAt: hours(1) });
        await store.revokeSessionsForUser(user.id);
        expect(await store.findAuthSession('a', new Date())).toBeNull();
        expect(await store.findAuthSession('b', new Date())).toBeNull();
      });

      it('lets a sign-in link be used once, even by two requests at the same instant', async () => {
        await store.createLoginChallenge({
          email: 'ada@example.com',
          tokenHash: 'link',
          anonymousUserId: null,
          expiresAt: hours(1),
        });
        const results = await Promise.all([
          store.consumeLoginChallenge('link', new Date()),
          store.consumeLoginChallenge('link', new Date()),
          store.consumeLoginChallenge('link', new Date()),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(results.find(Boolean)?.email).toBe('ada@example.com');
        expect(await store.consumeLoginChallenge('link', new Date())).toBeNull();
      });

      it('refuses an expired or unknown link', async () => {
        await store.createLoginChallenge({ email: 'a@example.com', tokenHash: 'old', anonymousUserId: null, expiresAt: hours(-1) });
        expect(await store.consumeLoginChallenge('old', new Date())).toBeNull();
        expect(await store.consumeLoginChallenge('never-issued', new Date())).toBeNull();
      });

      it('counts links requested for an address, for rate limiting', async () => {
        for (const hash of ['1', '2']) {
          await store.createLoginChallenge({ email: 'a@example.com', tokenHash: hash, anonymousUserId: null, expiresAt: hours(1) });
        }
        await store.createLoginChallenge({ email: 'b@example.com', tokenHash: '3', anonymousUserId: null, expiresAt: hours(1) });
        expect(await store.countLoginChallengesSince('a@example.com', hours(-1))).toBe(2);
        expect(await store.countLoginChallengesSince('a@example.com', hours(1))).toBe(0);
      });

      it('moves trips, and their runs, from one person to another', async () => {
        const [from, to] = [await newUser(), await newUser('ada@example.com')];
        const trip = await newTrip(from.id);
        await enqueued(trip.id, from.id);

        expect(await store.transferTrips(from.id, to.id)).toBe(1);
        const moved = await store.getSession(trip.id);
        expect(moved?.ownerId).toBe(to.id);
        // A move is a change like any other, so a stale editor is refused.
        expect(moved!.version).toBe(1);
        expect(await store.listSessions(from.id, 10)).toEqual([]);
        expect(await store.countRunsSince(to.id, hours(-1))).toBe(1);
      });

      it('deletes a person and everything of theirs, and nobody else’s', async () => {
        const [gone, kept] = [await newUser('gone@example.com'), await newUser('kept@example.com')];
        const goneTrip = await newTrip(gone.id);
        const keptTrip = await newTrip(kept.id);
        await store.createAuthSession({ userId: gone.id, tokenHash: 'gone', expiresAt: hours(1) });
        await store.createAuthSession({ userId: kept.id, tokenHash: 'kept', expiresAt: hours(1) });
        await enqueued(goneTrip.id, gone.id);

        await store.deleteUserAndData(gone.id);

        expect(await store.getUser(gone.id)).toBeNull();
        expect(await store.getSession(goneTrip.id)).toBeNull();
        expect(await store.findAuthSession('gone', new Date())).toBeNull();
        expect(await store.getUserByEmail('gone@example.com')).toBeNull();
        expect(await store.getSession(keptTrip.id)).not.toBeNull();
        expect(await store.findAuthSession('kept', new Date())).not.toBeNull();
      });

      it('exports what a person has', async () => {
        const user = await newUser('ada@example.com');
        const trip = await newTrip(user.id);
        await newTrip(await newUser().then((u) => u.id));

        const data = await store.exportUserData(user.id);
        expect(data?.user.email).toBe('ada@example.com');
        expect(data?.trips.map((t) => t.id)).toEqual([trip.id]);
        expect(await store.exportUserData(randomUUID())).toBeNull();
      });

      it('records an audit trail per trip, in order', async () => {
        const trip = await newTrip(null);
        await store.recordAudit({ tripId: trip.id, kind: 'trip.created', actor: 'u1', detail: { a: 1 } });
        await sleep(10);
        await store.recordAudit({ tripId: trip.id, kind: 'consent.accepted', actor: 'u1', detail: { b: 2 } });
        const trail = await store.listAudit(trip.id);
        expect(trail.map((e) => e.kind)).toEqual(['trip.created', 'consent.accepted']);
        expect(trail[1]!.detail).toEqual({ b: 2 });
      });

      it('sweeps what has expired and leaves the rest', async () => {
        const user = await newUser();
        await store.createAuthSession({ userId: user.id, tokenHash: 'old', expiresAt: hours(-1) });
        await store.createAuthSession({ userId: user.id, tokenHash: 'new', expiresAt: hours(1) });
        await store.createLoginChallenge({ email: 'a@example.com', tokenHash: 'c-old', anonymousUserId: null, expiresAt: hours(-72) });
        await store.createLoginChallenge({ email: 'a@example.com', tokenHash: 'c-new', anonymousUserId: null, expiresAt: hours(1) });
        await store.claimIdempotencyKey({ principal: null, scope: 's', key: 'k', requestHash: 'h' });
        await store.completeIdempotencyKey({ principal: null, scope: 's', key: 'k' }, { ok: true });

        const swept = await store.sweepExpired(new Date());
        expect(swept.authSessions).toBe(1);
        expect(swept.loginChallenges).toBe(1);
        expect(await store.findAuthSession('new', new Date())).not.toBeNull();

        // Far in the future, everything has expired.
        const later = await store.sweepExpired(hours(24 * 30));
        expect(later.authSessions).toBe(1);
        expect(later.idempotencyKeys).toBe(1);
      });
    });
  });
}
