import { describe, expect, it, vi } from 'vitest';
import { ProviderRegistry, loadProvidersEnv } from '@trip/providers';
import { BookingState } from '@trip/shared';
import { InMemoryRepository } from '../repository/memory.js';
import { PrismaRepository } from '../repository/prisma.js';
import { BookingChangedError, type IdempotencyInput, type TripRepository } from '../repository/types.js';
import { BookingService } from '../services/booking-service.js';
import { sessionFixture } from './helpers.js';

/**
 * Idempotency, tested against both stores. A retried or concurrent request
 * must never create a second booking, and one caller's key must never touch
 * another's. The PostgreSQL store is exercised through a fake client that
 * enforces the same unique primary key the real table has; no live database
 * was available, so that behaviour is checked here by construction only.
 */

// ------------------------------------------------------ fake Prisma client

type Row = { key: string; scope: string; response: unknown; expiresAt: Date };

function fakePrisma() {
  const claims = new Map<string, Row>();
  const bookings = new Map<string, Record<string, unknown>>();
  const uniqueViolation = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
  const matches = (row: Row, where: { key?: string; expiresAt?: { lte: Date }; response?: { path: string[]; equals: string } }) =>
    (where.key === undefined || row.key === where.key) &&
    (where.expiresAt === undefined || row.expiresAt <= where.expiresAt.lte) &&
    (where.response === undefined || (row.response as Record<string, unknown>)?.[where.response.path[0]!] === where.response.equals);

  const client = {
    idempotencyKey: {
      // The primary key: exactly one concurrent insert can win.
      create: async ({ data }: { data: Row }) => {
        if (claims.has(data.key)) throw uniqueViolation();
        claims.set(data.key, { ...data });
        return data;
      },
      findUnique: async ({ where }: { where: { key: string } }) => claims.get(where.key) ?? null,
      update: async ({ where, data }: { where: { key: string }; data: Partial<Row> }) => {
        const row = claims.get(where.key)!;
        Object.assign(row, data);
        return row;
      },
      deleteMany: async ({ where }: { where: Parameters<typeof matches>[1] }) => {
        let count = 0;
        for (const [k, row] of claims) if (matches(row, where)) (claims.delete(k), (count += 1));
        return { count };
      },
    },
    booking: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        // idempotencyKey is unique on the bookings table too.
        for (const b of bookings.values()) if (b['idempotencyKey'] === data['idempotencyKey']) throw uniqueViolation();
        bookings.set(data['id'] as string, { ...data, createdAt: new Date(), updatedAt: new Date() });
        return data;
      },
      findUnique: async ({ where }: { where: { id: string } }) => bookings.get(where.id) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => bookings.get(where.id)!,
      findMany: async ({ where }: { where: { tripId: string } }) =>
        [...bookings.values()].filter((b) => b['tripId'] === where.tripId),
      updateMany: async ({ where, data }: { where: { id: string; state: string }; data: Record<string, unknown> }) => {
        const row = bookings.get(where.id);
        if (!row || row['state'] !== where.state) return { count: 0 };
        Object.assign(row, data, { updatedAt: new Date() });
        return { count: 1 };
      },
    },
  };
  return { client, bookings, claims };
}

const stores: Array<[string, () => { repository: TripRepository }]> = [
  ['in-memory store', () => ({ repository: new InMemoryRepository() })],
  ['PostgreSQL store (fake client)', () => ({ repository: new PrismaRepository(fakePrisma().client as never) })],
];

const create = (service: BookingService, key: string, overrides: { principal?: string | null; offerId?: string } = {}) =>
  service.create(
    {
      tripId: sessionFixture().id,
      component: 'transport_outbound',
      offerId: overrides.offerId ?? 'offer-1',
      provider: 'amadeus',
      quotedPrice: { amount: 960000, currency: 'INR' },
      idempotencyKey: key,
      principal: overrides.principal ?? null,
    },
    sessionFixture(),
  );

async function setup(make: () => { repository: TripRepository }) {
  const { repository } = make();
  const service = new BookingService({ registry: new ProviderRegistry(loadProvidersEnv({})), repository });
  return { repository, service };
}

const settle = <T>(promises: Array<Promise<T>>) => Promise.allSettled(promises);

describe.each(stores)('idempotent booking creation: %s', (_name, make) => {
  it('creates exactly one booking when the same request arrives many times at once', async () => {
    const { service, repository } = await setup(make);

    const results = await settle(Array.from({ length: 25 }, () => create(service, 'race-key-0001')));

    const created = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof create>>> => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    // Each caller either got the one booking, or was told to retry.
    expect(new Set(created.map((r) => r.value.id)).size).toBe(1);
    for (const r of refused) expect((r as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
    // The point of the whole mechanism: one booking, however many callers.
    expect(await repository.listBookingsForTrip(sessionFixture().id)).toHaveLength(1);
    expect(created.length).toBeGreaterThanOrEqual(1);
  });

  it('returns the original booking to a later retry', async () => {
    const { service } = await setup(make);
    const first = await create(service, 'retry-key-0001');
    const second = await create(service, 'retry-key-0001');
    expect(second.id).toBe(first.id);
  });

  it('tells a concurrent duplicate the work is in progress, rather than starting it again', async () => {
    const { repository } = await setup(make);
    const input = { principal: null, scope: 'booking.create', key: 'inflight-0001' };

    expect(await repository.claimIdempotencyKey({ ...input, requestHash: 'h' })).toEqual({ status: 'claimed' });
    expect(await repository.claimIdempotencyKey({ ...input, requestHash: 'h' })).toEqual({ status: 'in_progress' });
  });

  it('refuses the same key used for a different request', async () => {
    const { service } = await setup(make);
    await create(service, 'reuse-key-0001', { offerId: 'offer-1' });

    await expect(create(service, 'reuse-key-0001', { offerId: 'offer-2' })).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringMatching(/different request/),
    });
  });

  it('gives two principals who pick the same key two separate bookings', async () => {
    const { service } = await setup(make);

    const alice = await create(service, 'shared-key-0001', { principal: 'user-alice' });
    const bob = await create(service, 'shared-key-0001', { principal: 'user-bob' });

    expect(bob.id).not.toBe(alice.id);
    // And neither can replay the other's: each key returns its own owner's booking.
    expect((await create(service, 'shared-key-0001', { principal: 'user-alice' })).id).toBe(alice.id);
    expect((await create(service, 'shared-key-0001', { principal: 'user-bob' })).id).toBe(bob.id);
  });

  it('keeps an anonymous caller apart from a named one with the same key', async () => {
    const { service } = await setup(make);
    const anonymous = await create(service, 'anon-key-0001', { principal: null });
    const named = await create(service, 'anon-key-0001', { principal: 'user-alice' });
    expect(named.id).not.toBe(anonymous.id);
  });

  it('lets the client retry after a failed attempt released the key', async () => {
    const { repository } = await setup(make);
    const input = { principal: null, scope: 'booking.create', key: 'fail-key-0001' };

    await repository.claimIdempotencyKey({ ...input, requestHash: 'h' });
    await repository.releaseIdempotencyKey(input);

    expect(await repository.claimIdempotencyKey({ ...input, requestHash: 'h' })).toEqual({ status: 'claimed' });
  });

  it('never releases a claim that finished, because that booking exists', async () => {
    const { repository } = await setup(make);
    const input = { principal: null, scope: 'booking.create', key: 'done-key-0001' };

    await repository.claimIdempotencyKey({ ...input, requestHash: 'h' });
    await repository.completeIdempotencyKey(input, { id: 'booking-1' });
    await repository.releaseIdempotencyKey(input);

    expect(await repository.claimIdempotencyKey({ ...input, requestHash: 'h' })).toEqual({
      status: 'completed',
      response: { id: 'booking-1' },
    });
  });

  it('does not release the key when the booking was created but recording it failed', async () => {
    const { repository } = await setup(make);
    const input: IdempotencyInput = { principal: null, scope: 'booking.create', key: 'half-key-0001' };
    const failing: TripRepository = Object.create(repository, {
      completeIdempotencyKey: { value: async () => { throw new Error('store hiccup'); } },
    });
    const service = new BookingService({ registry: new ProviderRegistry(loadProvidersEnv({})), repository: failing });

    await expect(create(service, input.key)).rejects.toThrow('store hiccup');
    // The booking exists, so a retry must be refused, not create another.
    await expect(create(service, input.key)).rejects.toMatchObject({ statusCode: 409 });
    expect(await repository.listBookingsForTrip(sessionFixture().id)).toHaveLength(1);
  });
});

describe.each(stores)('claims expire: %s', (_name, make) => {
  it('lets a request whose first attempt crashed be retried after the short claim window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { repository } = await setup(make);
      const input = { principal: null, scope: 'booking.create', key: 'crash-key-0001' };
      expect((await repository.claimIdempotencyKey({ ...input, requestHash: 'h' })).status).toBe('claimed');
      // Still inside the window: a retry is refused.
      vi.setSystemTime(Date.now() + 4 * 60 * 1000);
      expect((await repository.claimIdempotencyKey({ ...input, requestHash: 'h' })).status).toBe('in_progress');

      // Six minutes on: the crashed attempt's claim has lapsed.
      vi.setSystemTime(Date.now() + 2 * 60 * 1000);
      expect(await repository.claimIdempotencyKey({ ...input, requestHash: 'h' })).toEqual({ status: 'claimed' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.each(stores)('duplicate state transitions: %s', (_name, make) => {
  it('applies a transition at most once when two requests race', async () => {
    const { service, repository } = await setup(make);
    const booking = await create(service, 'transition-key-0001');
    expect(booking.state).toBe(BookingState.enum.draft);

    // Both read "draft" and both try to cancel it.
    const results = await settle([
      service.applyClientEvent(booking.id, 'CANCEL'),
      service.applyClientEvent(booking.id, 'CANCEL'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ statusCode: 409 });
    const stored = await repository.getBooking(booking.id);
    expect(stored?.history).toHaveLength(1);
  });

  it('refuses to save a booking that moved on since it was read', async () => {
    const { service, repository } = await setup(make);
    const booking = await create(service, 'stale-key-0001');
    await service.applyClientEvent(booking.id, 'CANCEL');

    await expect(repository.updateBooking({ ...booking, state: 'revalidating' }, 'draft')).rejects.toBeInstanceOf(
      BookingChangedError,
    );
  });
});
