import { randomUUID } from 'node:crypto';
import type { BookingRecord, PlanningSession, TravelerDetails } from '@trip/shared';
import {
  CHALLENGE_RETENTION_MS,
  EmailTakenError,
  RUN_RETENTION_MS,
  type AccountExport,
  type AuditRecord,
  type AuthSessionRecord,
  type FinishedRunStatus,
  type LoginChallengeRecord,
  type NewRun,
  type RunRecord,
  type Store,
  type SweepResult,
  type UserRecord,
} from './store.js';
import {
  BookingChangedError,
  IDEMPOTENCY_IN_PROGRESS_MS,
  IDEMPOTENCY_RETENTION_MS,
  TripChangedError,
  idempotencyId,
  storableSession,
  type IdempotencyClaim,
  type IdempotencyInput,
  type StoreHealth,
} from './types.js';

interface ChallengeRow extends LoginChallengeRecord {
  tokenHash: string;
  consumedAt: string | null;
}
interface AuthRow extends AuthSessionRecord {
  tokenHash: string;
}

const isActive = (r: RunRecord) => r.status === 'queued' || r.status === 'running';

/**
 * In-memory store for local development and tests.
 *
 * Everything lives in this process and disappears on restart. That is stated
 * in the health endpoint and refused outright in production, because a trip a
 * traveller spent twenty minutes building should not evaporate on a deploy.
 *
 * It follows the same rules as the PostgreSQL store, and the same contract
 * tests run against both: a save is checked against the version that was
 * read, a claim is atomic, a used sign-in link cannot be used again. Every
 * method here does its check and its write with no `await` in between, which
 * in one process is what a database transaction gives the other store.
 */
export class InMemoryRepository implements Store {
  private readonly sessions = new Map<string, PlanningSession>();
  private readonly bookings = new Map<string, BookingRecord>();
  private readonly travelers = new Map<string, TravelerDetails[]>();
  private readonly idempotency = new Map<
    string,
    { requestHash: string; response: unknown; expiresAt: number }
  >();
  private readonly runs = new Map<string, RunRecord>();
  private readonly users = new Map<string, UserRecord>();
  private readonly authSessions = new Map<string, AuthRow>();
  private readonly challenges = new Map<string, ChallengeRow>();
  private readonly audit: AuditRecord[] = [];

  /** The clock is a parameter so expiry can be tested without waiting. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  // ---------------------------------------------------------------- trips

  // Sessions are validated on write and copied in and out, so a caller that
  // mutates an object after saving it cannot change what is stored, exactly
  // as with a real database.
  async createSession(session: PlanningSession): Promise<PlanningSession> {
    const stored = storableSession({ ...session, version: 0 });
    this.sessions.set(stored.id, structuredClone(stored));
    return structuredClone(stored);
  }

  async getSession(id: string): Promise<PlanningSession | null> {
    const stored = this.sessions.get(id);
    return stored ? structuredClone(stored) : null;
  }

  async updateSession(session: PlanningSession): Promise<PlanningSession> {
    const current = this.sessions.get(session.id);
    if (!current || current.version !== session.version) throw new TripChangedError();
    const stored = storableSession({ ...session, version: session.version + 1, updatedAt: this.iso() });
    this.sessions.set(stored.id, structuredClone(stored));
    return structuredClone(stored);
  }

  async listSessions(ownerId: string, limit: number): Promise<PlanningSession[]> {
    return [...this.sessions.values()]
      .filter((s) => s.ownerId === ownerId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((s) => structuredClone(s));
  }

  async deleteSession(id: string): Promise<void> {
    this.removeTrip(id);
  }

  private removeTrip(id: string): void {
    this.sessions.delete(id);
    this.travelers.delete(id);
    for (const [bookingId, b] of this.bookings) if (b.tripId === id) this.bookings.delete(bookingId);
    for (const [runId, r] of this.runs) if (r.tripId === id) this.runs.delete(runId);
    for (let i = this.audit.length - 1; i >= 0; i -= 1) if (this.audit[i]!.tripId === id) this.audit.splice(i, 1);
  }

  // ------------------------------------------------------------- bookings

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
    const saved = { ...booking, updatedAt: this.iso() };
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

  // ---------------------------------------------------------- idempotency

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

  // ----------------------------------------------------------------- runs

  async enqueueRun(input: NewRun): Promise<{ run: RunRecord } | { active: RunRecord }> {
    const active = [...this.runs.values()].find((r) => r.tripId === input.tripId && isActive(r));
    if (active) return { active: structuredClone(active) };
    const run: RunRecord = {
      id: randomUUID(),
      tripId: input.tripId,
      ownerId: input.ownerId,
      kind: input.kind,
      status: 'queued',
      inputsHash: input.inputsHash,
      baseVersion: input.baseVersion,
      params: structuredClone(input.params),
      progress: null,
      error: null,
      attempts: 0,
      workerId: null,
      leaseUntil: null,
      cancelRequested: false,
      createdAt: this.iso(),
      startedAt: null,
      finishedAt: null,
    };
    this.runs.set(run.id, run);
    return { run: structuredClone(run) };
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : null;
  }

  async activeRunForTrip(tripId: string): Promise<RunRecord | null> {
    const run = [...this.runs.values()].find((r) => r.tripId === tripId && isActive(r));
    return run ? structuredClone(run) : null;
  }

  async latestRunForTrip(tripId: string): Promise<RunRecord | null> {
    const latest = [...this.runs.values()]
      .filter((r) => r.tripId === tripId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return latest ? structuredClone(latest) : null;
  }

  async claimRun(workerId: string, leaseMs: number, maxAttempts: number): Promise<RunRecord | null> {
    const now = this.now();
    const lapsed = (r: RunRecord) => r.status === 'running' && r.leaseUntil !== null && Date.parse(r.leaseUntil) < now;
    const next = [...this.runs.values()]
      .filter((r) => (r.status === 'queued' || lapsed(r)) && !r.cancelRequested && r.attempts < maxAttempts)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!next) return null;
    next.status = 'running';
    next.workerId = workerId;
    next.leaseUntil = new Date(now + leaseMs).toISOString();
    next.attempts += 1;
    next.startedAt ??= new Date(now).toISOString();
    return structuredClone(next);
  }

  async heartbeatRun(
    id: string,
    workerId: string,
    leaseMs: number,
    progress?: RunRecord['progress'],
  ): Promise<{ owned: boolean; cancelRequested: boolean }> {
    const run = this.runs.get(id);
    if (!run || run.status !== 'running' || run.workerId !== workerId) {
      return { owned: false, cancelRequested: false };
    }
    run.leaseUntil = new Date(this.now() + leaseMs).toISOString();
    if (progress) run.progress = progress;
    return { owned: true, cancelRequested: run.cancelRequested };
  }

  async finishRun(id: string, workerId: string, status: FinishedRunStatus, error?: RunRecord['error']): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run || run.status !== 'running' || run.workerId !== workerId) return false;
    run.status = status;
    run.error = error ?? null;
    run.finishedAt = this.iso();
    run.leaseUntil = null;
    if (status === 'succeeded') run.progress = { step: 'done', label: 'Done', percent: 100 };
    return true;
  }

  async requestCancel(id: string): Promise<RunRecord | null> {
    const run = this.runs.get(id);
    if (!run) return null;
    if (run.status === 'queued') {
      run.status = 'cancelled';
      run.finishedAt = this.iso();
    } else if (run.status === 'running') {
      run.cancelRequested = true;
    }
    return structuredClone(run);
  }

  async reapRuns(maxAttempts: number): Promise<number> {
    const now = this.now();
    let reaped = 0;
    for (const run of this.runs.values()) {
      if (run.status !== 'running' || run.leaseUntil === null || Date.parse(run.leaseUntil) >= now) continue;
      if (run.cancelRequested) {
        run.status = 'cancelled';
      } else if (run.attempts >= maxAttempts) {
        run.status = 'failed';
        run.error = {
          code: 'interrupted',
          message: 'The search was interrupted several times and was stopped. Please try again.',
        };
      } else {
        continue;
      }
      run.finishedAt = this.iso();
      run.leaseUntil = null;
      reaped += 1;
    }
    return reaped;
  }

  async countRunsSince(ownerId: string, since: Date): Promise<number> {
    return [...this.runs.values()].filter((r) => r.ownerId === ownerId && Date.parse(r.createdAt) >= since.getTime())
      .length;
  }

  // ------------------------------------------------------------- identity

  async createUser(input: { email: string | null }): Promise<UserRecord> {
    if (input.email !== null && this.userByEmail(input.email)) throw new EmailTakenError();
    const now = this.iso();
    const user: UserRecord = { id: randomUUID(), email: input.email, displayName: null, createdAt: now, lastSeenAt: now };
    this.users.set(user.id, user);
    return { ...user };
  }

  private userByEmail(email: string): UserRecord | undefined {
    return [...this.users.values()].find((u) => u.email === email);
  }

  async getUser(id: string): Promise<UserRecord | null> {
    const user = this.users.get(id);
    return user ? { ...user } : null;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const user = this.userByEmail(email);
    return user ? { ...user } : null;
  }

  async setUserEmail(id: string, email: string): Promise<UserRecord> {
    const user = this.users.get(id);
    if (!user) throw new Error(`Unknown user ${id}`);
    const holder = this.userByEmail(email);
    if (holder && holder.id !== id) throw new EmailTakenError();
    user.email = email;
    return { ...user };
  }

  async createAuthSession(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<AuthSessionRecord> {
    const now = this.iso();
    const row: AuthRow = {
      id: randomUUID(),
      userId: input.userId,
      tokenHash: input.tokenHash,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: input.expiresAt.toISOString(),
    };
    this.authSessions.set(row.id, row);
    const { tokenHash: _hash, ...record } = row;
    return record;
  }

  async findAuthSession(
    tokenHash: string,
    now: Date,
  ): Promise<{ session: AuthSessionRecord; user: UserRecord } | null> {
    const row = [...this.authSessions.values()].find((s) => s.tokenHash === tokenHash);
    if (!row || Date.parse(row.expiresAt) <= now.getTime()) return null;
    const user = this.users.get(row.userId);
    if (!user) return null;
    const { tokenHash: _hash, ...session } = row;
    return { session, user: { ...user } };
  }

  async touchAuthSession(id: string, lastSeenAt: Date, expiresAt: Date): Promise<void> {
    const row = this.authSessions.get(id);
    if (!row) return;
    row.lastSeenAt = lastSeenAt.toISOString();
    row.expiresAt = expiresAt.toISOString();
    const user = this.users.get(row.userId);
    if (user) user.lastSeenAt = row.lastSeenAt;
  }

  async revokeAuthSession(id: string): Promise<void> {
    this.authSessions.delete(id);
  }

  async revokeSessionsForUser(userId: string): Promise<void> {
    for (const [id, s] of this.authSessions) if (s.userId === userId) this.authSessions.delete(id);
  }

  async createLoginChallenge(input: {
    email: string;
    tokenHash: string;
    anonymousUserId: string | null;
    expiresAt: Date;
  }): Promise<void> {
    const row: ChallengeRow = {
      id: randomUUID(),
      email: input.email,
      tokenHash: input.tokenHash,
      anonymousUserId: input.anonymousUserId,
      createdAt: this.iso(),
      expiresAt: input.expiresAt.toISOString(),
      consumedAt: null,
    };
    this.challenges.set(row.id, row);
  }

  async consumeLoginChallenge(tokenHash: string, now: Date): Promise<LoginChallengeRecord | null> {
    const row = [...this.challenges.values()].find((c) => c.tokenHash === tokenHash);
    if (!row || row.consumedAt !== null || Date.parse(row.expiresAt) <= now.getTime()) return null;
    row.consumedAt = now.toISOString();
    return { id: row.id, email: row.email, anonymousUserId: row.anonymousUserId, createdAt: row.createdAt, expiresAt: row.expiresAt };
  }

  async countLoginChallengesSince(email: string, since: Date): Promise<number> {
    return [...this.challenges.values()].filter((c) => c.email === email && Date.parse(c.createdAt) >= since.getTime())
      .length;
  }

  async transferTrips(fromUserId: string, toUserId: string): Promise<number> {
    let moved = 0;
    for (const [id, session] of this.sessions) {
      if (session.ownerId !== fromUserId) continue;
      this.sessions.set(id, { ...session, ownerId: toUserId, version: session.version + 1 });
      moved += 1;
    }
    for (const run of this.runs.values()) if (run.ownerId === fromUserId) run.ownerId = toUserId;
    return moved;
  }

  async deleteUserAndData(userId: string): Promise<void> {
    for (const [id, session] of [...this.sessions]) if (session.ownerId === userId) this.removeTrip(id);
    for (const [id, s] of this.authSessions) if (s.userId === userId) this.authSessions.delete(id);
    for (const [id, c] of this.challenges) if (c.anonymousUserId === userId) this.challenges.delete(id);
    this.users.delete(userId);
  }

  async exportUserData(userId: string): Promise<AccountExport | null> {
    const user = this.users.get(userId);
    if (!user) return null;
    const trips = [...this.sessions.values()].filter((s) => s.ownerId === userId).map((s) => structuredClone(s));
    const bookings = trips.flatMap((t) => [...this.bookings.values()].filter((b) => b.tripId === t.id));
    return { user: { ...user }, trips, bookings: structuredClone(bookings) };
  }

  async recordAudit(input: {
    tripId: string | null;
    kind: string;
    actor: string;
    detail: Record<string, unknown>;
  }): Promise<void> {
    this.audit.push({ id: randomUUID(), createdAt: this.iso(), ...structuredClone(input) });
  }

  async listAudit(tripId: string): Promise<AuditRecord[]> {
    return this.audit.filter((a) => a.tripId === tripId).map((a) => structuredClone(a));
  }

  async sweepExpired(now: Date): Promise<SweepResult> {
    const t = now.getTime();
    const result: SweepResult = { authSessions: 0, loginChallenges: 0, idempotencyKeys: 0, runs: 0 };
    for (const [id, s] of this.authSessions) {
      if (Date.parse(s.expiresAt) <= t) {
        this.authSessions.delete(id);
        result.authSessions += 1;
      }
    }
    for (const [id, c] of this.challenges) {
      if (Date.parse(c.expiresAt) + CHALLENGE_RETENTION_MS <= t) {
        this.challenges.delete(id);
        result.loginChallenges += 1;
      }
    }
    for (const [id, k] of this.idempotency) {
      if (k.expiresAt <= t) {
        this.idempotency.delete(id);
        result.idempotencyKeys += 1;
      }
    }
    for (const [id, r] of this.runs) {
      if (!isActive(r) && r.finishedAt !== null && Date.parse(r.finishedAt) + RUN_RETENTION_MS <= t) {
        this.runs.delete(id);
        result.runs += 1;
      }
    }
    return result;
  }

  async healthCheck(): Promise<StoreHealth> {
    return {
      ok: true,
      store: 'in-memory',
      detail: 'Trips are held in this process only and are lost on restart. Set DATABASE_URL to persist them.',
    };
  }
}
