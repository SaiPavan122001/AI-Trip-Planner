import type { BookingRecord, PlanningSession, TravelerDetails } from '@trip/shared';
import { storableSession, type TripRepository } from './types.js';

/**
 * In-memory store for local development and tests.
 *
 * Everything lives in this process and disappears on restart. That is stated
 * in the health endpoint and refused outright in production, because a trip a
 * traveller spent twenty minutes building should not evaporate on a deploy.
 */
export class InMemoryRepository implements TripRepository {
  private readonly sessions = new Map<string, PlanningSession>();
  private readonly bookings = new Map<string, BookingRecord>();
  private readonly travelers = new Map<string, TravelerDetails[]>();
  private readonly idempotency = new Map<string, unknown | null>();

  // Sessions are validated on write and copied in and out, so a caller that
  // mutates an object after saving it cannot change what is stored, exactly
  // as with a real database.
  async createSession(session: PlanningSession): Promise<PlanningSession> {
    const stored = storableSession(session);
    this.sessions.set(stored.id, structuredClone(stored));
    return structuredClone(stored);
  }

  async getSession(id: string): Promise<PlanningSession | null> {
    const stored = this.sessions.get(id);
    return stored ? structuredClone(stored) : null;
  }

  async updateSession(session: PlanningSession): Promise<PlanningSession> {
    if (!this.sessions.has(session.id)) throw new Error(`Unknown session ${session.id}`);
    const stored = storableSession({ ...session, updatedAt: new Date().toISOString() });
    this.sessions.set(stored.id, structuredClone(stored));
    return structuredClone(stored);
  }

  async listSessions(ownerId: string | null, limit: number): Promise<PlanningSession[]> {
    return [...this.sessions.values()]
      .filter((s) => s.ownerId === ownerId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((s) => structuredClone(s));
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
    this.travelers.delete(id);
  }

  async createBooking(booking: BookingRecord): Promise<BookingRecord> {
    this.bookings.set(booking.id, booking);
    return booking;
  }

  async getBooking(id: string): Promise<BookingRecord | null> {
    return this.bookings.get(id) ?? null;
  }

  async updateBooking(booking: BookingRecord): Promise<BookingRecord> {
    this.bookings.set(booking.id, { ...booking, updatedAt: new Date().toISOString() });
    return this.bookings.get(booking.id)!;
  }

  async listBookingsForTrip(tripId: string): Promise<BookingRecord[]> {
    return [...this.bookings.values()].filter((b) => b.tripId === tripId);
  }

  async saveTravelerDetails(tripId: string, details: TravelerDetails[]): Promise<void> {
    this.travelers.set(tripId, details);
  }

  async getTravelerDetails(tripId: string): Promise<TravelerDetails[]> {
    return this.travelers.get(tripId) ?? [];
  }

  async claimIdempotencyKey(key: string, scope: string): Promise<{ existing: unknown | null }> {
    const composite = `${scope}:${key}`;
    if (this.idempotency.has(composite)) {
      return { existing: this.idempotency.get(composite) ?? null };
    }
    // Reserved with a null body: a concurrent retry sees the claim and waits
    // for the first request's result rather than starting a second booking.
    this.idempotency.set(composite, null);
    return { existing: null };
  }

  async completeIdempotencyKey(key: string, scope: string, response: unknown): Promise<void> {
    this.idempotency.set(`${scope}:${key}`, response);
  }

  async healthCheck(): Promise<{ ok: boolean; store: string; detail?: string }> {
    return {
      ok: true,
      store: 'in-memory',
      detail: 'Trips are held in this process only and are lost on restart. Set DATABASE_URL to persist them.',
    };
  }
}
