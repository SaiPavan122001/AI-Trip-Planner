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

/**
 * Who is making the request, what for, and the client's key. All three are
 * part of the identity of a claim: the same key from a different principal, or
 * for a different operation, is a different claim and can never see, block or
 * replay someone else's request.
 */
export interface IdempotencyInput {
  /** The authenticated user, or null for an anonymous caller. */
  principal: string | null;
  scope: string;
  key: string;
}

export type IdempotencyClaim =
  /** This caller owns the key and must do the work, then complete or release it. */
  | { status: 'claimed' }
  /** The same request already finished; return its stored response. */
  | { status: 'completed'; response: unknown }
  /** The same request is being processed right now by another caller. */
  | { status: 'in_progress' }
  /** The key was already used for a different request, which is a client bug. */
  | { status: 'mismatch' };

/** How long a finished claim is remembered, so any reasonable retry is covered. */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
/**
 * How long an unfinished claim blocks retries. Short, so a request that
 * crashed without releasing its key does not lock the client out for a day.
 */
export const IDEMPOTENCY_IN_PROGRESS_MS = 5 * 60 * 1000;

/** The stored identity of a claim. JSON keeps the parts unambiguous. */
export function idempotencyId({ principal, scope, key }: IdempotencyInput): string {
  return JSON.stringify([principal, scope, key]);
}

/** A booking changed underneath the caller, between reading it and saving it. */
export class BookingChangedError extends Error {
  constructor() {
    super('That booking was changed by another request. Reload it and try again.');
    this.name = 'BookingChangedError';
  }
}

export interface TripRepository {
  createSession(session: PlanningSession): Promise<PlanningSession>;
  getSession(id: string): Promise<PlanningSession | null>;
  updateSession(session: PlanningSession): Promise<PlanningSession>;
  listSessions(ownerId: string | null, limit: number): Promise<PlanningSession[]>;
  deleteSession(id: string): Promise<void>;

  createBooking(booking: BookingRecord): Promise<BookingRecord>;
  getBooking(id: string): Promise<BookingRecord | null>;
  /**
   * Saves a booking only if it is still in the state the caller read it in.
   * Two requests that both read `draft` and both try to move it on cannot
   * both succeed: the second finds the state has changed and gets
   * `BookingChangedError`, so a transition is applied at most once.
   */
  updateBooking(booking: BookingRecord, expectedState: BookingRecord['state']): Promise<BookingRecord>;
  listBookingsForTrip(tripId: string): Promise<BookingRecord[]>;

  /**
   * Traveller details are stored apart from the session because they contain
   * passport numbers and dates of birth. Keeping them in their own record
   * makes the retention and encryption rules enforceable in one place.
   */
  saveTravelerDetails(tripId: string, details: TravelerDetails[]): Promise<void>;
  getTravelerDetails(tripId: string): Promise<TravelerDetails[]>;

  /**
   * Atomically claims an idempotency key for one request. Exactly one of any
   * number of concurrent callers with the same key gets `claimed`; the rest
   * are told the work is still `in_progress`, or is `completed` and what
   * its response was. See `IdempotencyClaim`.
   */
  claimIdempotencyKey(input: IdempotencyInput & { requestHash: string }): Promise<IdempotencyClaim>;
  /** Stores the response for a claimed key, so retries return it. */
  completeIdempotencyKey(input: IdempotencyInput, response: unknown): Promise<void>;
  /**
   * Gives up a claim because the work failed, so the client may retry with the
   * same key. Without this, one failed request would block its key until the
   * claim expired.
   */
  releaseIdempotencyKey(input: IdempotencyInput): Promise<void>;

  healthCheck(): Promise<{ ok: boolean; store: string; detail?: string }>;
}
