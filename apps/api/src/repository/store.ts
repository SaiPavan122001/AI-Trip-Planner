import type {
  BookingRecord,
  PlanningSession,
  RunError,
  RunKind,
  RunProgress,
  RunStatus,
} from '@trip/shared';
import type { TripRepository } from './types.js';

/**
 * The rest of what the application stores: the queue of background searches,
 * and people with their sign-in state. Kept apart from `TripRepository` so
 * each interface stays readable, and joined into one `Store` because a single
 * database backs all of it.
 */

// ----------------------------------------------------------------- runs

/** A planning run as stored. `PlanningRunView` in @trip/shared is what clients see. */
export interface RunRecord {
  id: string;
  tripId: string;
  ownerId: string | null;
  kind: RunKind;
  status: RunStatus;
  inputsHash: string;
  baseVersion: number;
  /** Opaque to the store; the run service owns and validates its shape. */
  params: Record<string, unknown>;
  progress: RunProgress | null;
  error: RunError | null;
  attempts: number;
  workerId: string | null;
  leaseUntil: string | null;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface NewRun {
  tripId: string;
  ownerId: string | null;
  kind: RunKind;
  inputsHash: string;
  baseVersion: number;
  params: Record<string, unknown>;
}

export type FinishedRunStatus = Extract<RunStatus, 'succeeded' | 'failed' | 'cancelled' | 'superseded'>;

/**
 * The work queue for background searches. Every method that changes a run is
 * a single atomic step in the store, because the whole point is that several
 * workers and several requests can act at once without a run being taken
 * twice, finished twice, or started while another is active.
 */
export interface RunRepository {
  /**
   * Creates a queued run, unless the trip already has an active one, in which
   * case that run is returned and nothing is created. A trip has at most one
   * active run.
   */
  enqueueRun(input: NewRun): Promise<{ run: RunRecord } | { active: RunRecord }>;
  getRun(id: string): Promise<RunRecord | null>;
  activeRunForTrip(tripId: string): Promise<RunRecord | null>;
  latestRunForTrip(tripId: string): Promise<RunRecord | null>;
  /**
   * Takes the oldest queued run, or a running one whose lease has lapsed (its
   * worker crashed), for `workerId` for `leaseMs`. Runs that have already been
   * tried `maxAttempts` times are not taken.
   */
  claimRun(workerId: string, leaseMs: number, maxAttempts: number): Promise<RunRecord | null>;
  /**
   * Renews a lease and records progress. `owned` is false if the run is no
   * longer this worker's (its lease lapsed and another took it, or it was
   * finished), in which case the worker must stop and save nothing.
   */
  heartbeatRun(
    id: string,
    workerId: string,
    leaseMs: number,
    progress?: RunProgress,
  ): Promise<{ owned: boolean; cancelRequested: boolean }>;
  /** Ends a run this worker holds. False if it no longer holds it. */
  finishRun(id: string, workerId: string, status: FinishedRunStatus, error?: RunError): Promise<boolean>;
  /**
   * Stops a queued run at once; asks a running one to stop, which its worker
   * notices at its next heartbeat. A run that is already over is returned as it is.
   */
  requestCancel(id: string): Promise<RunRecord | null>;
  /**
   * Ends runs no worker will finish: lapsed runs that have used all their
   * attempts fail, and lapsed runs the traveller asked to cancel are cancelled.
   */
  reapRuns(maxAttempts: number): Promise<number>;
  /** How many runs this person has started since `since`, for daily quotas. */
  countRunsSince(ownerId: string, since: Date): Promise<number>;
}

// ------------------------------------------------------------- identity

export interface UserRecord {
  id: string;
  /** Null for someone who has not signed in. */
  email: string | null;
  displayName: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface AuthSessionRecord {
  id: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface LoginChallengeRecord {
  id: string;
  email: string;
  anonymousUserId: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface AuditRecord {
  id: string;
  tripId: string | null;
  kind: string;
  actor: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface AccountExport {
  user: UserRecord;
  trips: PlanningSession[];
  bookings: BookingRecord[];
}

/** An email is already attached to a different person. */
export class EmailTakenError extends Error {
  constructor() {
    super('That email already belongs to another account.');
    this.name = 'EmailTakenError';
  }
}

export interface IdentityRepository {
  createUser(input: { email: string | null }): Promise<UserRecord>;
  getUser(id: string): Promise<UserRecord | null>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  /** Attaches an email to a user who has none. `EmailTakenError` if another user has it. */
  setUserEmail(id: string, email: string): Promise<UserRecord>;

  createAuthSession(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<AuthSessionRecord>;
  /** The live session for a token hash and its user, or null if unknown or expired. */
  findAuthSession(tokenHash: string, now: Date): Promise<{ session: AuthSessionRecord; user: UserRecord } | null>;
  touchAuthSession(id: string, lastSeenAt: Date, expiresAt: Date): Promise<void>;
  revokeAuthSession(id: string): Promise<void>;
  revokeSessionsForUser(userId: string): Promise<void>;

  createLoginChallenge(input: {
    email: string;
    tokenHash: string;
    anonymousUserId: string | null;
    expiresAt: Date;
  }): Promise<void>;
  /** Single-use: marks an unexpired, unused link as used and returns it. A second call returns null. */
  consumeLoginChallenge(tokenHash: string, now: Date): Promise<LoginChallengeRecord | null>;
  countLoginChallengesSince(email: string, since: Date): Promise<number>;

  /** Moves every trip from one user to another, returning how many moved. */
  transferTrips(fromUserId: string, toUserId: string): Promise<number>;
  /** Removes a user with their trips, bookings, traveller details, sessions and runs. */
  deleteUserAndData(userId: string): Promise<void>;
  exportUserData(userId: string): Promise<AccountExport | null>;

  recordAudit(input: {
    tripId: string | null;
    kind: string;
    actor: string;
    detail: Record<string, unknown>;
  }): Promise<void>;
  listAudit(tripId: string): Promise<AuditRecord[]>;

  /** Housekeeping: removes what has expired. Returns how many rows went. */
  sweepExpired(now: Date): Promise<SweepResult>;
}

export interface SweepResult {
  authSessions: number;
  loginChallenges: number;
  idempotencyKeys: number;
  runs: number;
}

/** How long a finished run is kept before housekeeping removes it. */
export const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a used or expired sign-in link is kept, for rate limiting and audit. */
export const CHALLENGE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Everything the application stores. */
export type Store = TripRepository & RunRepository & IdentityRepository;
