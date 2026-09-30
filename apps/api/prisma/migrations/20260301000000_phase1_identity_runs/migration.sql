-- Phase 1: accounts and sessions, background planning runs, optimistic locking.
-- Additive only: nothing is dropped and no existing column loses data.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "email" DROP NOT NULL;

-- AlterTable
ALTER TABLE "trips" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_challenges" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "anonymousUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "login_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planning_runs" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "ownerId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "inputsHash" TEXT NOT NULL,
    "baseVersion" INTEGER NOT NULL,
    "params" JSONB NOT NULL,
    "progress" JSONB,
    "error" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "workerId" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "planning_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_tokenHash_key" ON "auth_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "auth_sessions_userId_idx" ON "auth_sessions"("userId");

-- CreateIndex
CREATE INDEX "auth_sessions_expiresAt_idx" ON "auth_sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "login_challenges_tokenHash_key" ON "login_challenges"("tokenHash");

-- CreateIndex
CREATE INDEX "login_challenges_email_createdAt_idx" ON "login_challenges"("email", "createdAt");

-- CreateIndex
CREATE INDEX "login_challenges_expiresAt_idx" ON "login_challenges"("expiresAt");

-- CreateIndex
CREATE INDEX "planning_runs_status_createdAt_idx" ON "planning_runs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "planning_runs_tripId_createdAt_idx" ON "planning_runs"("tripId", "createdAt");

-- CreateIndex
CREATE INDEX "planning_runs_ownerId_createdAt_idx" ON "planning_runs"("ownerId", "createdAt");

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_runs" ADD CONSTRAINT "planning_runs_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A trip has at most one active planning run. Prisma cannot express a partial
-- index, so it exists only here; the repository relies on the violation.
CREATE UNIQUE INDEX "planning_runs_one_active_per_trip" ON "planning_runs"("tripId") WHERE "status" IN ('queued', 'running');
