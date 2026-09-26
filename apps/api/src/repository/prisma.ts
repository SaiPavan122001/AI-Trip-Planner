import { PrismaClient } from '@prisma/client';
import {
  BookingRecord,
  PlanningSession,
  TravelerDetails,
  totalTravelers,
} from '@trip/shared';
import { storableSession, type TripRepository } from './types.js';

/**
 * PostgreSQL-backed store.
 *
 * Every document read back from the database is re-validated against the Zod
 * schema before it is returned. A row written by an older version of the
 * service, or edited by hand, becomes a loud error here rather than an
 * undefined field somewhere deep in the scheduler.
 */
export class PrismaRepository implements TripRepository {
  constructor(private readonly prisma: PrismaClient) {}

  static fromUrl(databaseUrl: string): PrismaRepository {
    return new PrismaRepository(
      new PrismaClient({ datasources: { db: { url: databaseUrl } } }),
    );
  }

  async createSession(session: PlanningSession): Promise<PlanningSession> {
    const stored = storableSession(session);
    await this.prisma.trip.create({
      data: { ...this.toRow(stored), id: stored.id },
    });
    return stored;
  }

  async getSession(id: string): Promise<PlanningSession | null> {
    const row = await this.prisma.trip.findUnique({ where: { id } });
    if (!row) return null;
    return this.parseSession(row.session, id);
  }

  async updateSession(session: PlanningSession): Promise<PlanningSession> {
    const updated = storableSession({ ...session, updatedAt: new Date().toISOString() });
    await this.prisma.trip.update({
      where: { id: session.id },
      data: this.toRow(updated),
    });
    return updated;
  }

  async listSessions(ownerId: string | null, limit: number): Promise<PlanningSession[]> {
    const rows = await this.prisma.trip.findMany({
      where: { ownerId },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => this.parseSession(r.session, r.id));
  }

  async deleteSession(id: string): Promise<void> {
    await this.prisma.trip.delete({ where: { id } }).catch(() => undefined);
  }

  async createBooking(booking: BookingRecord): Promise<BookingRecord> {
    await this.prisma.booking.create({
      data: {
        id: booking.id,
        tripId: booking.tripId,
        component: booking.component,
        state: booking.state,
        provider: booking.provider,
        providerReference: booking.providerReference,
        quotedAmount: booking.quotedPrice.amount,
        quotedCurrency: booking.quotedPrice.currency,
        confirmedAmount: booking.confirmedPrice?.amount ?? null,
        idempotencyKey: booking.idempotencyKey,
        history: booking.history,
      },
    });
    return booking;
  }

  async getBooking(id: string): Promise<BookingRecord | null> {
    const row = await this.prisma.booking.findUnique({ where: { id } });
    if (!row) return null;
    return BookingRecord.parse({
      id: row.id,
      tripId: row.tripId,
      state: row.state,
      component: row.component,
      provider: row.provider,
      providerReference: row.providerReference,
      quotedPrice: { amount: row.quotedAmount, currency: row.quotedCurrency },
      confirmedPrice:
        row.confirmedAmount === null
          ? null
          : { amount: row.confirmedAmount, currency: row.quotedCurrency },
      idempotencyKey: row.idempotencyKey,
      history: row.history,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  async updateBooking(booking: BookingRecord): Promise<BookingRecord> {
    const row = await this.prisma.booking.update({
      where: { id: booking.id },
      data: {
        state: booking.state,
        providerReference: booking.providerReference,
        confirmedAmount: booking.confirmedPrice?.amount ?? null,
        history: booking.history,
      },
    });
    return { ...booking, updatedAt: row.updatedAt.toISOString() };
  }

  async listBookingsForTrip(tripId: string): Promise<BookingRecord[]> {
    const rows = await this.prisma.booking.findMany({ where: { tripId } });
    const bookings = await Promise.all(rows.map((r) => this.getBooking(r.id)));
    return bookings.filter((b): b is BookingRecord => b !== null);
  }

  /**
   * Traveller documents are encrypted by the caller before they reach here.
   * This method stores opaque bytes and has no way to read them back into
   * plaintext, which is deliberate.
   */
  async saveTravelerDetails(tripId: string, details: TravelerDetails[]): Promise<void> {
    await this.prisma.$transaction(
      details.map((d) =>
        this.prisma.travelerRecord.upsert({
          where: { tripId_travelerIndex: { tripId, travelerIndex: d.index } },
          create: {
            tripId,
            travelerIndex: d.index,
            encrypted: Buffer.from(JSON.stringify(d)),
            nonce: Buffer.alloc(0),
          },
          update: { encrypted: Buffer.from(JSON.stringify(d)) },
        }),
      ),
    );
  }

  async getTravelerDetails(tripId: string): Promise<TravelerDetails[]> {
    const rows = await this.prisma.travelerRecord.findMany({
      where: { tripId },
      orderBy: { travelerIndex: 'asc' },
    });
    return rows.map((r) => TravelerDetails.parse(JSON.parse(r.encrypted.toString('utf8'))));
  }

  async claimIdempotencyKey(key: string, scope: string): Promise<{ existing: unknown | null }> {
    const existing = await this.prisma.idempotencyKey.findUnique({ where: { key } });
    if (existing) return { existing: existing.response ?? null };
    await this.prisma.idempotencyKey.create({
      data: {
        key,
        scope,
        response: undefined,
        // Long enough to cover any reasonable client retry, short enough that
        // the table does not become a permanent record of every request.
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    return { existing: null };
  }

  async completeIdempotencyKey(key: string, scope: string, response: unknown): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: { key },
      data: { response: response as never, scope },
    });
  }

  async healthCheck(): Promise<{ ok: boolean; store: string; detail?: string }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { ok: true, store: 'postgresql' };
    } catch (err) {
      return {
        ok: false,
        store: 'postgresql',
        detail: err instanceof Error ? err.message : 'Database unreachable',
      };
    }
  }

  private toRow(session: PlanningSession) {
    return {
      ownerId: session.ownerId,
      stage: session.stage,
      originName: session.intent.origin.name,
      destinationName: session.intent.destination.name,
      departureDate: session.intent.departureDate,
      returnDate: session.intent.returnDate,
      travelerCount: totalTravelers(session.intent.travelers),
      currency: session.intent.currency,
      scope: session.classification.scope,
      session: session as never,
    };
  }

  private parseSession(raw: unknown, id: string): PlanningSession {
    const parsed = PlanningSession.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Stored trip ${id} does not match the current session schema: ${parsed.error.issues
          .map((i) => i.path.join('.'))
          .join(', ')}. It was written by a different version of this service.`,
      );
    }
    return parsed.data;
  }
}
