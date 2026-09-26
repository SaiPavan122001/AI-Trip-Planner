import { inject } from 'vitest';
import { PrismaRepository } from '../repository/prisma.js';
import { describeStoreContract } from './support/store-contract.js';

/** The same contract as the in-memory store, against a real PostgreSQL. */
describeStoreContract('PostgreSQL', async () => {
  const url = inject('databaseUrl');
  const store = PrismaRepository.fromUrl(url);
  const prisma = (store as unknown as { prisma: import('@prisma/client').PrismaClient }).prisma;

  return {
    store,
    reset: async () => {
      // A guard for TEST_DATABASE_URL: this empties every table, so it only
      // ever runs against a database that is named as a test database.
      const name = new URL(url).pathname;
      if (!/test/i.test(name)) throw new Error(`Refusing to empty ${name}: the database name must contain "test".`);
      await prisma.$executeRawUnsafe(
        'TRUNCATE "audit_events","planning_runs","traveler_records","bookings","trips","auth_sessions","login_challenges","idempotency_keys","users" CASCADE',
      );
    },
    close: async () => {
      await prisma.$disconnect();
    },
  };
});
