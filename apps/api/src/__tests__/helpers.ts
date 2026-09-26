import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { ProviderRegistry, loadProvidersEnv } from '@trip/providers';
import { TripLlm } from '@trip/llm';
import { PlanningSession, emptyConstraintSet, emptyTravelerProfile, ok } from '@trip/shared';
import { buildServer } from '../server.js';
import { hashToken, newToken } from '../auth/tokens.js';
import { InMemoryRepository } from '../repository/memory.js';
import type { Store } from '../repository/store.js';
import { loadEnv, type Env } from '../env.js';
import type { AppContext } from '../context.js';

/** Shared fixtures for the API tests. Real places, no personal data. */

export const TRIP_ID = '11111111-1111-4111-8111-111111111111';

const place = (id: string, name: string, lat: number, lon: number, iata = '') => ({
  id,
  name,
  displayName: `${name}, India`,
  coordinates: { lat, lon },
  countryCode: 'IN',
  countryName: 'India',
  timezone: 'Asia/Kolkata',
  airports: iata ? [{ iataCode: iata, name: `${name} airport`, distanceKm: 20, coordinates: null }] : [],
  source: 'test',
  resolvedAt: '2026-01-01T00:00:00.000Z',
});

/** A trip at the questionnaire stage, parsed through the real schema so defaults apply. */
export function sessionFixture(id: string = TRIP_ID, ownerId: string | null = null): PlanningSession {
  return PlanningSession.parse({
    id,
    ownerId,
    stage: 'planned',
    intent: {
      originQuery: 'Hyderabad',
      destinationQuery: 'Bengaluru',
      departureDate: '2030-11-10',
      returnDate: '2030-11-14',
      travelers: { adults: 2, children: 0, infants: 0 },
      currency: 'INR',
      origin: place('p1', 'Hyderabad', 17.385, 78.4867, 'HYD'),
      destination: place('p2', 'Bengaluru', 12.9716, 77.5946, 'BLR'),
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

const KNOWN_PLACES: Record<string, ReturnType<typeof place>> = {
  hyderabad: place('p1', 'Hyderabad', 17.385, 78.4867, 'HYD'),
  bengaluru: place('p2', 'Bengaluru', 12.9716, 77.5946, 'BLR'),
  mysuru: place('p3', 'Mysuru', 12.2958, 76.6394, 'MYQ'),
};

/** A place lookup that knows three Indian cities and nothing else, so trips can be created offline. */
export const fakeGeocoder = {
  descriptor: { id: 'fake-geo', label: 'Fake places', kinds: ['geocoding'], requiredEnv: [], coverage: 'global', docsUrl: null, attribution: null },
  isConfigured: () => true,
  health: async () => ok({ ok: true as const, latencyMs: 1 }, provenance()),
  resolvePlace: async (query: string) => {
    const found = KNOWN_PLACES[query.trim().toLowerCase().split(',')[0]!];
    return found ? ok([found], provenance()) : ok([], provenance());
  },
  reverse: async () => ok(KNOWN_PLACES['hyderabad']!, provenance()),
};

function provenance() {
  return {
    provider: 'fake-geo',
    providerLabel: 'Fake places',
    retrievedAt: '2026-01-01T00:00:00.000Z',
    validUntil: null,
    searchId: null,
    attribution: null,
  } as never;
}

export interface TestUser {
  id: string;
  /** The value of the Cookie header that signs a request in as this person. */
  cookie: string;
}

/** A person with a live session, made straight in the store, the way sign-in leaves them. */
export async function signedInUser(store: Store, env: Env, email: string | null = null): Promise<TestUser> {
  const user = await store.createUser({ email });
  const token = newToken();
  await store.createAuthSession({
    userId: user.id,
    tokenHash: hashToken(env.sessionSecret, token),
    expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000),
  });
  return { id: user.id, cookie: `${env.COOKIE_NAME}=${token}` };
}

/**
 * The app as one person's browser sees it: every request carries their cookie
 * unless the test passes its own. Anything else on the app is passed through.
 */
export function actingAs(app: FastifyInstance, user: TestUser): FastifyInstance {
  return new Proxy(app, {
    get(target, prop) {
      if (prop === 'inject') {
        return (opts: { headers?: Record<string, string> } & Record<string, unknown>) =>
          target.inject({ ...opts, headers: { cookie: user.cookie, ...opts.headers } } as never);
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export function testEnv(extra: Record<string, string> = {}): Env {
  return loadEnv({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', ...extra });
}

function withFakeGeocoder(registry: ProviderRegistry): ProviderRegistry {
  registry.geocoding.push(fakeGeocoder as never);
  return registry;
}

export interface TestApp {
  /** As the trip's owner: requests carry their cookie. */
  app: FastifyInstance;
  /** The same server with no cookie, for tests about not being signed in. */
  bare: FastifyInstance;
  repository: InMemoryRepository;
  ctx: AppContext;
  owner: TestUser;
  /** Signs in someone else, and returns the app as they see it. */
  asStranger: (email?: string | null) => Promise<{ app: FastifyInstance; user: TestUser }>;
}

/**
 * A server with no providers configured, which is also the honest default a
 * fresh clone runs in, backed by an in-memory store the test can inspect.
 * The fixture trip belongs to `owner`, and `app` is signed in as them.
 */
export async function buildTestApp(
  overrides: Partial<AppContext> & {
    seedTrip?: boolean;
    envVars?: Record<string, string>;
    /** Give the server a place lookup that knows Hyderabad, Bengaluru and Mysuru. */
    geocoding?: boolean;
  } = {},
): Promise<TestApp> {
  const { seedTrip = true, envVars, geocoding = false, ...contextOverrides } = overrides;
  const repository = (contextOverrides.repository as InMemoryRepository | undefined) ?? new InMemoryRepository();
  const env = contextOverrides.env ?? testEnv(envVars);
  const owner = await signedInUser(repository, env);
  if (seedTrip) await repository.createSession(sessionFixture(TRIP_ID, owner.id));

  const { app: bare, ctx } = await buildServer({
    env,
    logger: pino({ level: 'silent' }),
    registry: geocoding
      ? withFakeGeocoder(new ProviderRegistry(loadProvidersEnv({})))
      : new ProviderRegistry(loadProvidersEnv({})),
    llm: new TripLlm(null),
    ...contextOverrides,
    repository,
  });
  return {
    app: actingAs(bare, owner),
    bare,
    repository,
    ctx,
    owner,
    asStranger: async (email = null) => {
      const user = await signedInUser(repository, env, email);
      return { app: actingAs(bare, user), user };
    },
  };
}
