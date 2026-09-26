import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { ProviderRegistry, loadProvidersEnv } from '@trip/providers';
import { TripLlm } from '@trip/llm';
import { PlanningSession, emptyConstraintSet, emptyTravelerProfile } from '@trip/shared';
import { buildServer } from '../server.js';
import { InMemoryRepository } from '../repository/memory.js';
import { loadEnv } from '../env.js';
import type { AppContext } from '../context.js';

/** Shared fixtures for the API tests. Real places, no personal data. */

export const TRIP_ID = '11111111-1111-4111-8111-111111111111';

const place = (id: string, name: string, lat: number, lon: number) => ({
  id,
  name,
  displayName: `${name}, India`,
  coordinates: { lat, lon },
  countryCode: 'IN',
  countryName: 'India',
  timezone: 'Asia/Kolkata',
  airports: [],
  source: 'test',
  resolvedAt: '2026-01-01T00:00:00.000Z',
});

/** A planned domestic trip, parsed through the real schema so defaults apply. */
export function sessionFixture(id: string = TRIP_ID): PlanningSession {
  return PlanningSession.parse({
    id,
    ownerId: null,
    stage: 'planned',
    intent: {
      originQuery: 'Hyderabad',
      destinationQuery: 'Bengaluru',
      departureDate: '2030-11-10',
      returnDate: '2030-11-14',
      travelers: { adults: 2, children: 0, infants: 0 },
      currency: 'INR',
      origin: place('p1', 'Hyderabad', 17.385, 78.4867),
      destination: place('p2', 'Bengaluru', 12.9716, 77.5946),
    },
    classification: {
      scope: 'domestic',
      originCountry: 'IN',
      destinationCountry: 'IN',
      greatCircleKm: 497,
      crossesTimezones: false,
      originTimezone: 'Asia/Kolkata',
      destinationTimezone: 'Asia/Kolkata',
      surfaceRoutePlausible: true,
      eligibleModes: ['flight', 'train'],
      excludedModes: [],
      documentationNotes: [],
    },
    profile: emptyTravelerProfile(),
    constraints: emptyConstraintSet(),
    questionnaire: null,
    plans: [],
    selectedPlanId: null,
    providerNotes: [],
    decisionLog: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

/**
 * A server with no providers configured, which is also the honest default a
 * fresh clone runs in, backed by an in-memory store the test can inspect.
 */
export async function buildTestApp(
  overrides: Partial<AppContext> = {},
): Promise<{ app: FastifyInstance; repository: InMemoryRepository }> {
  const repository = new InMemoryRepository();
  await repository.createSession(sessionFixture());
  const { app } = await buildServer({
    env: loadEnv({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    logger: pino({ level: 'silent' }),
    registry: new ProviderRegistry(loadProvidersEnv({})),
    llm: new TripLlm(null),
    repository,
    ...overrides,
  });
  return { app, repository };
}
