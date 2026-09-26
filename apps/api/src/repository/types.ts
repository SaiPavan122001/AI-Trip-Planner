import { PlanningSession, type BookingRecord, type TravelerDetails } from '@trip/shared';

/**
 * Validates a session against the schema before it is written. Both stores
 * call this, so the in-memory store behaves like PostgreSQL and a document
 * that could not be read back is never stored in the first place: one bad
 * value must not make a traveller's trip permanently unreadable.
 *
 * Failing here is a bug in the service, not bad input, so it throws a plain
 * Error (reported as a 500) naming only the offending paths, never values.
 */
export function storableSession(session: PlanningSession): PlanningSession {
  const parsed = PlanningSession.safeParse(session);
  if (!parsed.success) {
    throw new Error(
      `Refusing to store trip ${session.id}: it does not match the session schema at ${parsed.error.issues
        .map((i) => i.path.join('.'))
        .join(', ')}.`,
    );
  }
  return parsed.data;
}

/**
 * Persistence boundary.
 *
 * The API talks to this interface, never to Prisma directly, which is what
 * lets the service run against an in-memory store for local development and
 * PostgreSQL in production without a second code path through the routes.
 */

export interface TripRepository {
  createSession(session: PlanningSession): Promise<PlanningSession>;
  getSession(id: string): Promise<PlanningSession | null>;
  updateSession(session: PlanningSession): Promise<PlanningSession>;
  listSessions(ownerId: string | null, limit: number): Promise<PlanningSession[]>;
  deleteSession(id: string): Promise<void>;

  createBooking(booking: BookingRecord): Promise<BookingRecord>;
  getBooking(id: string): Promise<BookingRecord | null>;
  updateBooking(booking: BookingRecord): Promise<BookingRecord>;
  listBookingsForTrip(tripId: string): Promise<BookingRecord[]>;

  /**
   * Traveller details are stored apart from the session because they contain
   * passport numbers and dates of birth. Keeping them in their own record
   * makes the retention and encryption rules enforceable in one place.
   */
  saveTravelerDetails(tripId: string, details: TravelerDetails[]): Promise<void>;
  getTravelerDetails(tripId: string): Promise<TravelerDetails[]>;

  /**
   * Returns the stored response for an idempotency key, or null when this is
   * the first time the key has been seen. Booking routes use this so a retried
   * request cannot create a second reservation.
   */
  claimIdempotencyKey(key: string, scope: string): Promise<{ existing: unknown | null }>;
  completeIdempotencyKey(key: string, scope: string, response: unknown): Promise<void>;

  healthCheck(): Promise<{ ok: boolean; store: string; detail?: string }>;
}
