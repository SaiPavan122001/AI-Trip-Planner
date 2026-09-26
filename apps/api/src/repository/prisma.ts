import { Prisma, PrismaClient } from '@prisma/client';
import {
  BookingRecord,
  PlanningSession,
  TravelerDetails,
  totalTravelers,
  type RunKind,
  type RunStatus,
} from '@trip/shared';
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

/** The database's own clock, as the UTC wall time Prisma stores in TIMESTAMP(3) columns. */
const DB_NOW = Prisma.sql`(NOW() AT TIME ZONE 'UTC')`;

/**
 * PostgreSQL-backed store.
 *
 * Every document read back from the database is re-validated against the Zod
 * schema before it is returned. A row written by an older version of the
 * service, or edited by hand, becomes a loud error here rather than an
 * undefined field somewhere deep in the scheduler.
 */
export class PrismaRepository implements Store {
  constructor(private readonly prisma: PrismaClient) {}

  static fromUrl(databaseUrl: string): PrismaRepository {
    return new PrismaRepository(
      new PrismaClient({ datasources: { db: { url: databaseUrl } } }),
    );
  }

  async createSession(session: PlanningSession): Promise<PlanningSession> {
    const stored = storableSession({ ...session, version: 0 });
    await this.prisma.trip.create({
      data: { ...this.toRow(stored), id: stored.id, version: 0 },
    });
    return stored;
  }

  async getSession(id: string): Promise<PlanningSession | null> {
    const row = await this.prisma.trip.findUnique({ where: { id } });
    return row ? this.fromRow(row) : null;
  }

  async updateSession(session: PlanningSession): Promise<PlanningSession> {
    const updated = storableSession({
      ...session,
      version: session.version + 1,
      updatedAt: new Date().toISOString(),
    });
    // One statement, conditional on the version the caller read. If another
    // save got in first the row no longer matches, nothing is written, and
    // the caller is told rather than overwriting that save.
    const { count } = await this.prisma.trip.updateMany({
      where: { id: session.id, version: session.version },
      data: { ...this.toRow(updated), version: updated.version },
    });
    if (count === 0) throw new TripChangedError();
    return updated;
  }

  async listSessions(ownerId: string, limit: number): Promise<PlanningSession[]> {
    const rows = await this.prisma.trip.findMany({
      where: { ownerId },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => this.fromRow(r));
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

  async updateBooking(booking: BookingRecord, expectedState: BookingRecord['state']): Promise<BookingRecord> {
    // One statement: the row is only updated if it is still in the state the
    // caller read, so two requests cannot both apply a transition.
    const { count } = await this.prisma.booking.updateMany({
      where: { id: booking.id, state: expectedState },
      data: {
        state: booking.state,
        providerReference: booking.providerReference,
        confirmedAmount: booking.confirmedPrice?.amount ?? null,
        history: booking.history,
      },
    });
    if (count === 0) throw new BookingChangedError();
    const row = await this.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
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

  /**
   * The claim is one row whose primary key is the claim's identity
   * (principal, scope and key together). Creating it is a single atomic
   * insert: when several requests race, the database lets exactly one
   * succeed and the rest see the unique violation. There is no
   * check-then-insert window for a second booking to slip through.
   */
  async claimIdempotencyKey(input: IdempotencyInput & { requestHash: string }): Promise<IdempotencyClaim> {
    const key = idempotencyId(input);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.prisma.idempotencyKey.create({
          data: {
            key,
            scope: input.scope,
            response: { requestHash: input.requestHash, state: 'in_progress' },
            expiresAt: new Date(Date.now() + IDEMPOTENCY_IN_PROGRESS_MS),
          },
        });
        return { status: 'claimed' };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }

      const row = await this.prisma.idempotencyKey.findUnique({ where: { key } });
      // Deleted between the failed insert and this read: try to claim again.
      if (!row) continue;
      if (row.expiresAt.getTime() <= Date.now()) {
        // An expired claim is free. Deleting it is conditional on it still
        // being expired, so two callers cannot both take it over.
        await this.prisma.idempotencyKey.deleteMany({ where: { key, expiresAt: { lte: new Date() } } });
        continue;
      }
      const stored = parseClaim(row.response);
      if (stored.requestHash !== input.requestHash) return { status: 'mismatch' };
      return stored.state === 'completed'
        ? { status: 'completed', response: stored.body }
        : { status: 'in_progress' };
    }
    // Lost the race three times running: treat it as still in progress.
    return { status: 'in_progress' };
  }

  async completeIdempotencyKey(input: IdempotencyInput, response: unknown): Promise<void> {
    const key = idempotencyId(input);
    const row = await this.prisma.idempotencyKey.findUnique({ where: { key } });
    if (!row) return;
    await this.prisma.idempotencyKey.update({
      where: { key },
      data: {
        response: { requestHash: parseClaim(row.response).requestHash, state: 'completed', body: response as never },
        expiresAt: new Date(Date.now() + IDEMPOTENCY_RETENTION_MS),
      },
    });
  }

  async releaseIdempotencyKey(input: IdempotencyInput): Promise<void> {
    // Only an unfinished claim: a completed one records something that happened.
    await this.prisma.idempotencyKey.deleteMany({
      where: { key: idempotencyId(input), response: { path: ['state'], equals: 'in_progress' } },
    });
  }

  // ----------------------------------------------------------------- runs

  async enqueueRun(input: NewRun): Promise<{ run: RunRecord } | { active: RunRecord }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const row = await this.prisma.planningRun.create({
          data: {
            tripId: input.tripId,
            ownerId: input.ownerId,
            kind: input.kind,
            status: 'queued',
            inputsHash: input.inputsHash,
            baseVersion: input.baseVersion,
            params: input.params as Prisma.InputJsonValue,
          },
        });
        return { run: toRun(row) };
      } catch (err) {
        // The partial unique index allows one queued or running run per trip.
        if (!isUniqueViolation(err)) throw err;
      }
      const active = await this.activeRunForTrip(input.tripId);
      if (active) return { active };
      // It finished between the failed insert and the read: try again.
    }
    throw new Error(`Could not queue a planning run for trip ${input.tripId}.`);
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const row = await this.prisma.planningRun.findUnique({ where: { id } });
    return row ? toRun(row) : null;
  }

  async activeRunForTrip(tripId: string): Promise<RunRecord | null> {
    const row = await this.prisma.planningRun.findFirst({
      where: { tripId, status: { in: ['queued', 'running'] } },
    });
    return row ? toRun(row) : null;
  }

  async latestRunForTrip(tripId: string): Promise<RunRecord | null> {
    const row = await this.prisma.planningRun.findFirst({ where: { tripId }, orderBy: { createdAt: 'desc' } });
    return row ? toRun(row) : null;
  }

  async claimRun(workerId: string, leaseMs: number, maxAttempts: number): Promise<RunRecord | null> {
    // FOR UPDATE SKIP LOCKED lets any number of workers poll at once: each
    // takes a different row, and none waits for another's lock.
    const rows = await this.prisma.$queryRaw<RawRun[]>`
      UPDATE "planning_runs"
      SET "status" = 'running',
          "workerId" = ${workerId},
          "leaseUntil" = ${DB_NOW} + make_interval(secs => ${leaseMs / 1000}::float8),
          "attempts" = "attempts" + 1,
          "startedAt" = COALESCE("startedAt", ${DB_NOW})
      WHERE "id" = (
        SELECT "id" FROM "planning_runs"
        WHERE ("status" = 'queued' OR ("status" = 'running' AND "leaseUntil" < ${DB_NOW}))
          AND "cancelRequested" = false
          AND "attempts" < ${maxAttempts}::int
        ORDER BY "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *`;
    return rows[0] ? toRun(rows[0]) : null;
  }

  async heartbeatRun(
    id: string,
    workerId: string,
    leaseMs: number,
    progress?: RunRecord['progress'],
  ): Promise<{ owned: boolean; cancelRequested: boolean }> {
    const rows = await this.prisma.$queryRaw<Array<{ cancelRequested: boolean }>>`
      UPDATE "planning_runs"
      SET "leaseUntil" = ${DB_NOW} + make_interval(secs => ${leaseMs / 1000}::float8),
          "progress" = COALESCE(${progress ? JSON.stringify(progress) : null}::jsonb, "progress")
      WHERE "id" = ${id} AND "status" = 'running' AND "workerId" = ${workerId}
      RETURNING "cancelRequested"`;
    return rows[0]
      ? { owned: true, cancelRequested: rows[0].cancelRequested }
      : { owned: false, cancelRequested: false };
  }

  async finishRun(
    id: string,
    workerId: string,
    status: FinishedRunStatus,
    error?: RunRecord['error'],
  ): Promise<boolean> {
    const { count } = await this.prisma.planningRun.updateMany({
      where: { id, status: 'running', workerId },
      data: {
        status,
        error: error ? (error as Prisma.InputJsonValue) : Prisma.DbNull,
        finishedAt: new Date(),
        leaseUntil: null,
        ...(status === 'succeeded' ? { progress: { step: 'done', label: 'Done', percent: 100 } } : {}),
      },
    });
    return count > 0;
  }

  async requestCancel(id: string): Promise<RunRecord | null> {
    const stopped = await this.prisma.planningRun.updateMany({
      where: { id, status: 'queued' },
      data: { status: 'cancelled', finishedAt: new Date() },
    });
    if (stopped.count === 0) {
      await this.prisma.planningRun.updateMany({ where: { id, status: 'running' }, data: { cancelRequested: true } });
    }
    return this.getRun(id);
  }

  async reapRuns(maxAttempts: number): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "planning_runs"
      SET "status" = CASE WHEN "cancelRequested" THEN 'cancelled' ELSE 'failed' END,
          "error" = CASE WHEN "cancelRequested" THEN NULL ELSE
            '{"code":"interrupted","message":"The search was interrupted several times and was stopped. Please try again."}'::jsonb END,
          "finishedAt" = ${DB_NOW},
          "leaseUntil" = NULL
      WHERE "status" = 'running' AND "leaseUntil" < ${DB_NOW}
        AND ("cancelRequested" = true OR "attempts" >= ${maxAttempts}::int)`;
  }

  async countRunsSince(ownerId: string, since: Date): Promise<number> {
    return this.prisma.planningRun.count({ where: { ownerId, createdAt: { gte: since } } });
  }

  // ------------------------------------------------------------- identity

  async createUser(input: { email: string | null }): Promise<UserRecord> {
    try {
      return toUser(await this.prisma.user.create({ data: { email: input.email } }));
    } catch (err) {
      if (isUniqueViolation(err)) throw new EmailTakenError();
      throw err;
    }
  }

  async getUser(id: string): Promise<UserRecord | null> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row ? toUser(row) : null;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.prisma.user.findUnique({ where: { email } });
    return row ? toUser(row) : null;
  }

  async setUserEmail(id: string, email: string): Promise<UserRecord> {
    try {
      return toUser(await this.prisma.user.update({ where: { id }, data: { email } }));
    } catch (err) {
      if (isUniqueViolation(err)) throw new EmailTakenError();
      throw err;
    }
  }

  async createAuthSession(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<AuthSessionRecord> {
    return toAuthSession(await this.prisma.authSession.create({ data: input }));
  }

  async findAuthSession(
    tokenHash: string,
    now: Date,
  ): Promise<{ session: AuthSessionRecord; user: UserRecord } | null> {
    const row = await this.prisma.authSession.findUnique({ where: { tokenHash }, include: { user: true } });
    if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
    return { session: toAuthSession(row), user: toUser(row.user) };
  }

  async touchAuthSession(id: string, lastSeenAt: Date, expiresAt: Date): Promise<void> {
    const touched = await this.prisma.authSession.updateMany({ where: { id }, data: { lastSeenAt, expiresAt } });
    if (touched.count === 0) return;
    const session = await this.prisma.authSession.findUnique({ where: { id }, select: { userId: true } });
    if (session) await this.prisma.user.updateMany({ where: { id: session.userId }, data: { lastSeenAt } });
  }

  async revokeAuthSession(id: string): Promise<void> {
    await this.prisma.authSession.deleteMany({ where: { id } });
  }

  async revokeSessionsForUser(userId: string): Promise<void> {
    await this.prisma.authSession.deleteMany({ where: { userId } });
  }

  async createLoginChallenge(input: {
    email: string;
    tokenHash: string;
    anonymousUserId: string | null;
    expiresAt: Date;
  }): Promise<void> {
    await this.prisma.loginChallenge.create({ data: input });
  }

  async consumeLoginChallenge(tokenHash: string, now: Date): Promise<LoginChallengeRecord | null> {
    // The conditional update is the single-use guarantee: of two requests
    // presenting the same link, only one finds it unused.
    const { count } = await this.prisma.loginChallenge.updateMany({
      where: { tokenHash, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (count === 0) return null;
    const row = await this.prisma.loginChallenge.findUnique({ where: { tokenHash } });
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      anonymousUserId: row.anonymousUserId,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  async countLoginChallengesSince(email: string, since: Date): Promise<number> {
    return this.prisma.loginChallenge.count({ where: { email, createdAt: { gte: since } } });
  }

  async transferTrips(fromUserId: string, toUserId: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const moved = await tx.trip.updateMany({
        where: { ownerId: fromUserId },
        data: { ownerId: toUserId, version: { increment: 1 } },
      });
      await tx.planningRun.updateMany({ where: { ownerId: fromUserId }, data: { ownerId: toUserId } });
      await tx.booking.updateMany({ where: { ownerId: fromUserId }, data: { ownerId: toUserId } });
      return moved.count;
    });
  }

  async deleteUserAndData(userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Trips carry bookings, traveller records, runs and audit events with
      // them (cascading deletes), so nothing about the person is left behind.
      await tx.trip.deleteMany({ where: { ownerId: userId } });
      await tx.booking.deleteMany({ where: { ownerId: userId } });
      await tx.loginChallenge.deleteMany({ where: { anonymousUserId: userId } });
      await tx.idempotencyKey.deleteMany({ where: { key: { startsWith: `["${userId}"` } } });
      await tx.user.deleteMany({ where: { id: userId } });
    });
  }

  async exportUserData(userId: string): Promise<AccountExport | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return null;
    const rows = await this.prisma.trip.findMany({ where: { ownerId: userId }, orderBy: { createdAt: 'asc' } });
    const trips = rows.map((r) => this.fromRow(r));
    const bookings = (await Promise.all(trips.map((t) => this.listBookingsForTrip(t.id)))).flat();
    return { user: toUser(user), trips, bookings };
  }

  async recordAudit(input: {
    tripId: string | null;
    kind: string;
    actor: string;
    detail: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        tripId: input.tripId,
        kind: input.kind,
        actor: input.actor,
        detail: input.detail as Prisma.InputJsonValue,
      },
    });
  }

  async listAudit(tripId: string): Promise<AuditRecord[]> {
    const rows = await this.prisma.auditEvent.findMany({ where: { tripId }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({
      id: r.id,
      tripId: r.tripId,
      kind: r.kind,
      actor: r.actor,
      detail: (r.detail ?? {}) as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async sweepExpired(now: Date): Promise<SweepResult> {
    const [authSessions, loginChallenges, idempotencyKeys, runs] = await Promise.all([
      this.prisma.authSession.deleteMany({ where: { expiresAt: { lte: now } } }),
      this.prisma.loginChallenge.deleteMany({
        where: { expiresAt: { lte: new Date(now.getTime() - CHALLENGE_RETENTION_MS) } },
      }),
      this.prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lte: now } } }),
      this.prisma.planningRun.deleteMany({
        where: {
          status: { notIn: ['queued', 'running'] },
          finishedAt: { lte: new Date(now.getTime() - RUN_RETENTION_MS) },
        },
      }),
    ]);
    return {
      authSessions: authSessions.count,
      loginChallenges: loginChallenges.count,
      idempotencyKeys: idempotencyKeys.count,
      runs: runs.count,
    };
  }

  async healthCheck(): Promise<StoreHealth> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { ok: true, store: 'postgresql' };
    } catch (err) {
      // The health endpoint is public, and a driver's error text can name
      // the host, the database and the user. `detail` is safe to send; the
      // route logs `cause` for operators and never returns it.
      return {
        ok: false,
        store: 'postgresql',
        detail: 'The database could not be reached.',
        cause: err instanceof Error ? err.message : String(err),
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

  /** The columns are the truth for who owns a trip and which version it is at. */
  private fromRow(row: { id: string; ownerId: string | null; version: number; session: unknown }): PlanningSession {
    const doc = (row.session ?? {}) as Record<string, unknown>;
    return this.parseSession({ ...doc, ownerId: row.ownerId, version: row.version }, row.id);
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

/** PostgreSQL's unique-violation, as Prisma reports it (P2002). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/** What a claim row stores in its JSON column. */
function parseClaim(raw: unknown): { requestHash: string; state: 'in_progress' | 'completed'; body?: unknown } {
  const value = (raw ?? {}) as { requestHash?: unknown; state?: unknown; body?: unknown };
  return {
    requestHash: typeof value.requestHash === 'string' ? value.requestHash : '',
    state: value.state === 'completed' ? 'completed' : 'in_progress',
    body: value.body,
  };
}

type RawRun = {
  id: string;
  tripId: string;
  ownerId: string | null;
  kind: string;
  status: string;
  inputsHash: string;
  baseVersion: number;
  params: unknown;
  progress: unknown;
  error: unknown;
  attempts: number;
  workerId: string | null;
  leaseUntil: Date | null;
  cancelRequested: boolean;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

function toRun(row: RawRun): RunRecord {
  return {
    id: row.id,
    tripId: row.tripId,
    ownerId: row.ownerId,
    kind: row.kind as RunKind,
    status: row.status as RunStatus,
    inputsHash: row.inputsHash,
    baseVersion: row.baseVersion,
    params: (row.params ?? {}) as Record<string, unknown>,
    progress: (row.progress ?? null) as RunRecord['progress'],
    error: (row.error ?? null) as RunRecord['error'],
    attempts: row.attempts,
    workerId: row.workerId,
    leaseUntil: row.leaseUntil?.toISOString() ?? null,
    cancelRequested: row.cancelRequested,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

function toUser(row: {
  id: string;
  email: string | null;
  displayName: string | null;
  createdAt: Date;
  lastSeenAt: Date;
}): UserRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

function toAuthSession(row: {
  id: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}): AuthSessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}
