import {
  IsolatingPolicy,
  ProviderRegistry,
  SelfDriveProvider,
  loadProvidersEnv,
  type ActivityProvider,
  type BusProvider,
  type FlightProvider,
  type HotelProvider,
  type ProviderDescriptor,
  type RailProvider,
  type RoutingProvider,
  type VehicleProfile,
} from '@trip/providers';
import {
  fail,
  money,
  ok,
  type ActivityOffer,
  type HotelOffer,
  type ProviderProvenance,
  type ProviderResult,
  type TransportOffer,
} from '@trip/shared';

/**
 * A real `ProviderRegistry` filled with in-memory providers, so engine tests
 * exercise the same registry, policy and note code the service runs, with
 * nothing on the network. Each provider is a function from request to result,
 * so a test can make one succeed, find nothing, be limited, throw or hang.
 */

export const provenance = (id: string): ProviderProvenance => ({
  provider: id,
  providerLabel: `Test ${id}`,
  retrievedAt: '2026-01-01T00:00:00.000Z',
  validUntil: null,
  searchId: null,
  attribution: null,
});

const descriptor = (id: string, kind: ProviderDescriptor['kinds'][number], coverage: 'global' | string[] = 'global'): ProviderDescriptor => ({
  id,
  label: `Test ${id}`,
  kinds: [kind],
  requiredEnv: [],
  coverage,
  docsUrl: null,
  attribution: null,
});

const healthy = (id: string) => async () => ok({ ok: true as const, latencyMs: 1 }, provenance(id));

export type Search<Req, Out> = (req: Req) => Promise<ProviderResult<Out>>;

export function flightProvider(id: string, search: Search<never, TransportOffer[]>): FlightProvider {
  return {
    descriptor: descriptor(id, 'flight'),
    isConfigured: () => true,
    health: healthy(id),
    searchFlights: search as never,
    revalidateFlight: async () => {
      throw new Error('not used');
    },
  };
}

export function hotelProvider(id: string, search: Search<never, HotelOffer[]>): HotelProvider {
  return {
    descriptor: descriptor(id, 'hotel'),
    isConfigured: () => true,
    health: healthy(id),
    searchHotels: search as never,
    revalidateHotel: async () => {
      throw new Error('not used');
    },
  };
}

export function railProvider(id: string, search: Search<never, TransportOffer[]>, coverage: 'global' | string[] = 'global'): RailProvider {
  return { descriptor: descriptor(id, 'rail', coverage), isConfigured: () => true, health: healthy(id), searchTrains: search as never };
}

export function busProvider(id: string, search: Search<never, TransportOffer[]>, coverage: 'global' | string[] = 'global'): BusProvider {
  return { descriptor: descriptor(id, 'bus', coverage), isConfigured: () => true, health: healthy(id), searchBuses: search as never };
}

export function activityProvider(id: string, search: Search<never, ActivityOffer[]>): ActivityProvider {
  return { descriptor: descriptor(id, 'activity'), isConfigured: () => true, health: healthy(id), searchActivities: search as never };
}

export function routingProvider(id: string, distanceKm: number, durationMinutes: number): RoutingProvider {
  return {
    descriptor: descriptor(id, 'routing'),
    isConfigured: () => true,
    health: healthy(id),
    route: async () => ok({ distanceKm, durationMinutes, geometry: null }, provenance(id)),
  };
}

export interface RegistryParts {
  flights?: FlightProvider[];
  hotels?: HotelProvider[];
  rail?: RailProvider[];
  buses?: BusProvider[];
  activities?: ActivityProvider[];
  /** Adds a self-drive provider over a routing provider that measures this drive. */
  selfDrive?: { distanceKm: number; durationMinutes: number; profile?: VehicleProfile | null };
  /** The deadline the registry's policy puts on one provider call. Defaults to none. */
  deadlineMs?: number | null;
}

export function registryWith(parts: RegistryParts = {}): ProviderRegistry {
  const registry = new ProviderRegistry(loadProvidersEnv({}), new IsolatingPolicy({ deadlineMs: parts.deadlineMs ?? null }));
  registry.flights.push(...(parts.flights ?? []));
  registry.hotels.push(...(parts.hotels ?? []));
  registry.rail.push(...(parts.rail ?? []));
  registry.buses.push(...(parts.buses ?? []));
  registry.activities.push(...(parts.activities ?? []));
  if (parts.selfDrive) {
    const routing = routingProvider('routing', parts.selfDrive.distanceKm, parts.selfDrive.durationMinutes);
    registry.routing.push(routing);
    Object.assign(registry, { selfDrive: new SelfDriveProvider(routing, parts.selfDrive.profile ?? null) });
  }
  return registry;
}

/** Ways a provider can answer, for tests that only care about the outcome. */
export const answers = {
  ok: <T>(data: T, id = 'test'): ProviderResult<T> => ok(data, provenance(id)),
  empty: (id = 'test'): ProviderResult<never> => fail('no_availability', id, `Test ${id}`, 'Nothing was found.'),
  rateLimited: (id = 'test'): ProviderResult<never> => fail('rate_limited', id, `Test ${id}`, `Test ${id} is rate limiting requests right now.`, 30),
  down: (id = 'test'): ProviderResult<never> => fail('unavailable', id, `Test ${id}`, `Test ${id} returned an error.`),
  unusable: (id = 'test'): ProviderResult<never> => fail('invalid_response', id, `Test ${id}`, `Test ${id} returned a response this planner could not use, so it was discarded.`),
};

export const never = () => new Promise<never>(() => undefined);

export const rupees = (amount: number) => money(amount, 'INR');
