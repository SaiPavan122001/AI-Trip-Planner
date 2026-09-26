import type { BookingRecord, PlanningSession, TravelerDetails } from '@trip/shared';
import {
  BookingChangedError,
  IDEMPOTENCY_IN_PROGRESS_MS,
  IDEMPOTENCY_RETENTION_MS,
  idempotencyId,
  storableSession,
  type IdempotencyClaim,
  type IdempotencyInput,
  type TripRepository,
} from './types.js';

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
  private readonly idempotency = new Map<
    string,
    { requestHash: string; response: unknown; expiresAt: number }
  >();

  /** The clock is a parameter so expiry can be tested without waiting. */
  constructor(private readonly now: () => number = () => Date.now()) {}

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

  async updateBooking(booking: BookingRecord, expectedState: BookingRecord['state']): Promise<BookingRecord> {
    // No await between the check and the write, so in one process they are
    // atomic; the PostgreSQL store does the same in a single statement.
    const current = this.bookings.get(booking.id);
    if (!current || current.state !== expectedState) throw new BookingChangedError();
    const saved = { ...booking, updatedAt: new Date().toISOString() };
    this.bookings.set(booking.id, saved);
    return saved;
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

  async claimIdempotencyKey(input: IdempotencyInput & { requestHash: string }): Promise<IdempotencyClaim> {
    // Everything from the lookup to the write is synchronous, so in one
    // process two concurrent callers cannot both find the key free. The
    // PostgreSQL store gets the same guarantee from a unique primary key.
    const id = idempotencyId(input);
    const now = this.now();
    const existing = this.idempotency.get(id);
    if (existing && existing.expiresAt > now) {
      if (existing.requestHash !== input.requestHash) return { status: 'mismatch' };
      return existing.response === undefined
        ? { status: 'in_progress' }
        : { status: 'completed', response: structuredClone(existing.response) };
    }
    this.idempotency.set(id, {
      requestHash: input.requestHash,
      response: undefined,
      expiresAt: now + IDEMPOTENCY_IN_PROGRESS_MS,
    });
    return { status: 'claimed' };
  }

  async completeIdempotencyKey(input: IdempotencyInput, response: unknown): Promise<void> {
    const id = idempotencyId(input);
    const claim = this.idempotency.get(id);
    if (!claim) return;
    this.idempotency.set(id, {
      ...claim,
      response: structuredClone(response),
      expiresAt: this.now() + IDEMPOTENCY_RETENTION_MS,
    });
  }

  async releaseIdempotencyKey(input: IdempotencyInput): Promise<void> {
    const id = idempotencyId(input);
    // Only an unfinished claim can be released; a completed one is a record
    // of something that happened.
    if (this.idempotency.get(id)?.response === undefined) this.idempotency.delete(id);
  }

  async healthCheck(): Promise<{ ok: boolean; store: string; detail?: string }> {
    return {
      ok: true,
      store: 'in-memory',
      detail: 'Trips are held in this process only and are lost on restart. Set DATABASE_URL to persist them.',
    };
  }
}
