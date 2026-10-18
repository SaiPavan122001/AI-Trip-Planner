import {
  CAPABILITY_LABEL,
  type ProviderCapability,
  type ProviderFailure,
  type ProviderResult,
} from '@trip/shared';
import { MemoryCache, type AsyncCache } from '@trip/shared';
import { CachedActivityProvider, CachedGeocodingProvider, CachedRoutingProvider, ResponseCache } from './cache.js';
import { FallbackRoutingProvider } from './fallback.js';
import { type ProviderPolicy } from './guard.js';
import { configureHttp } from './http.js';
import { ResilientPolicy, type PolicyEvent } from './policy.js';
import { AmadeusProvider } from './adapters/amadeus.js';
import { BusEstimateProvider } from './adapters/bus-estimate.js';
import { DuffelProvider } from './adapters/duffel.js';
import { HotelbedsActivitiesProvider } from './adapters/hotelbeds-activities.js';
import { HotelbedsClient } from './adapters/hotelbeds-client.js';
import { HotelbedsHotelsProvider } from './adapters/hotelbeds-hotels.js';
import { HotelbedsTransfersProvider } from './adapters/hotelbeds-transfers.js';
import { GenericBusProvider, GenericRailProvider } from './adapters/generic-surface.js';
import { GooglePlacesProvider, GoogleRoutesProvider } from './adapters/google-maps.js';
import { NominatimProvider } from './adapters/nominatim.js';
import { OsrmRoutingProvider, OsrmTransferProvider } from './adapters/osrm.js';
import { SelfDriveProvider } from './adapters/self-drive.js';
import { loadProvidersEnv, type ProvidersEnv } from './config.js';
import type {
  ActivityProvider,
  BaseProvider,
  BusProvider,
  FlightProvider,
  GeocodingProvider,
  GroundTransportProvider,
  HotelProvider,
  QuotedTransferProvider,
  RailProvider,
  RoutingProvider,
} from './types.js';
import { covers } from './types.js';

/**
 * The registry is the only place that knows which adapters exist. Everything
 * downstream asks for a capability ("who can search trains in IN?") and gets
 * either providers or an explicit, quotable reason why none are available.
 */

export interface DisabledProvider {
  id: string;
  label: string;
  reason: string;
  requiredEnv: string[];
  /**
   * What its absence means for each capability it would serve, in words for a
   * traveller. One vendor can serve several,
   * and each is reported on its own so the two are never merged into one note.
   */
  capabilities: Partial<Record<ProviderCapability, string>>;
}

/** What a host process may supply: a shared cache (Redis), and a way to hear about circuit changes. */
export interface RegistryExtras {
  /** A ready-made cache. */
  cache?: ResponseCache;
  /** Or only where to keep entries (Redis, shared between instances); the time to live and the limits come from the environment. */
  cacheStore?: AsyncCache;
  onPolicyEvent?: (event: PolicyEvent) => void;
}

export class ProviderRegistry {
  readonly geocoding: GeocodingProvider[] = [];
  readonly flights: FlightProvider[] = [];
  readonly hotels: HotelProvider[] = [];
  readonly rail: RailProvider[] = [];
  readonly buses: BusProvider[] = [];
  readonly routing: RoutingProvider[] = [];
  readonly groundTransport: GroundTransportProvider[] = [];
  /** Providers that sell a transfer between places they know by code (Hotelbeds Transfers); not a replacement for routing. */
  readonly quotedTransfers: QuotedTransferProvider[] = [];
  readonly activities: ActivityProvider[] = [];
  /** Populated for every adapter that exists but cannot run. Surfaced in the UI. */
  readonly disabled: DisabledProvider[] = [];
  readonly selfDrive: SelfDriveProvider | null = null;
  /** Kept separately because airport lookup is a Duffel-specific capability. */
  readonly duffel: DuffelProvider | null = null;
  /** Operator-configured ground tariffs, by currency. The planner uses these
   *  to model local transport cost; with none configured it models nothing. */
  readonly taxiTariffs: ProvidersEnv['taxiTariffs'];
  /**
   * Every provider call the planner makes goes through this. The default
   * isolates failures, enforces the call's share of the search's time, and
   * keeps a circuit breaker per provider and capability (`policy.ts`).
   */
  readonly policy: ProviderPolicy;
  /** The cache behind the place, route and things-to-do lookups; null when caching is off. */
  readonly cache: ResponseCache | null;

  constructor(env: ProvidersEnv, policy?: ProviderPolicy, extras: RegistryExtras = {}) {
    this.taxiTariffs = env.taxiTariffs;
    configureHttp({ maxRetries: env.policy.maxRetries, maxRetryDelayMs: env.policy.retryMaxDelayMs });
    this.policy =
      policy ??
      new ResilientPolicy({
        deadlineMs: env.policy.callTimeoutMs,
        circuit: { failureThreshold: env.policy.circuitFailureThreshold, recoveryTimeoutMs: env.policy.circuitRecoveryMs },
        ...(extras.onPolicyEvent ? { onEvent: extras.onPolicyEvent } : {}),
      });
    this.cache = !env.cache.enabled
      ? null
      : (extras.cache ??
        new ResponseCache({
          store: extras.cacheStore ?? new MemoryCache({ maxEntries: env.cache.maxEntries }),
          ttls: { geocodingMs: env.cache.geocodingTtlMs, routingMs: env.cache.routingTtlMs, activitiesMs: env.cache.activitiesTtlMs },
        }));
    const cache = this.cache;
    const nominatim = new NominatimProvider(env.nominatim);
    if (nominatim.isConfigured()) this.geocoding.push(cache ? new CachedGeocodingProvider(nominatim, cache) : nominatim);
    else
      this.disable(
        'nominatim',
        'OpenStreetMap Nominatim',
        'Set NOMINATIM_USER_AGENT to a contact address. The geocoder is required to resolve places and classify the journey.',
        ['NOMINATIM_USER_AGENT'],
        { geocoding: 'No place lookup is configured: set NOMINATIM_USER_AGENT to a contact address so places can be resolved and the journey classified.' },
      );

    if (env.osrm) {
      const rawOsrm = new OsrmRoutingProvider(env.osrm);
      const osrmRouting = cache ? new CachedRoutingProvider(rawOsrm, cache) : rawOsrm;
      this.routing.push(osrmRouting);
    } else {
      this.disable(
        'osrm',
        'OSRM routing',
        'Set OSRM_BASE_URL to enable road routing, transfers and self-drive legs.',
        ['OSRM_BASE_URL'],
        {
          routing: 'No road routing is configured: set OSRM_BASE_URL (or GOOGLE_MAPS_API_KEY).',
          transfers: 'No routing provider is connected, so transfers are timed by assumption and not priced: set OSRM_BASE_URL (or GOOGLE_MAPS_API_KEY) to measure them.',
          self_drive: 'No routing provider is connected, so a drive cannot be measured: set OSRM_BASE_URL (or GOOGLE_MAPS_API_KEY).',
        },
      );
    }

    if (env.google) {
      const rawGoogle = new GoogleRoutesProvider(env.google);
      const googleRouting = cache ? new CachedRoutingProvider(rawGoogle, cache) : rawGoogle;
      // Google goes first when present: traffic-aware durations are the
      // difference between a transfer that works and one that misses a flight.
      this.routing.unshift(googleRouting);
      const places = new GooglePlacesProvider(env.google);
      this.activities.push(cache ? new CachedActivityProvider(places, cache) : places);
    } else {
      this.disable(
        'google-maps',
        'Google Maps Platform',
        'Set GOOGLE_MAPS_API_KEY to include things to do with published opening hours and traffic-aware transfer times.',
        ['GOOGLE_MAPS_API_KEY'],
        {
          activities: 'No things-to-do source is connected: set GOOGLE_MAPS_API_KEY to include places with published opening hours.',
          transfers: 'No traffic-aware routing is connected: set GOOGLE_MAPS_API_KEY for transfer times that reflect traffic.',
          self_drive: 'No traffic-aware routing is connected: set GOOGLE_MAPS_API_KEY for drive times that reflect traffic.',
        },
      );
    }

    if (env.duffel) {
      const duffel = new DuffelProvider(env.duffel);
      this.duffel = duffel;
      this.flights.push(duffel);
    } else {
      this.disable(
        'duffel',
        'Duffel',
        'Set DUFFEL_ACCESS_TOKEN (a duffel_test_ token for test mode) to search flights.',
        ['DUFFEL_ACCESS_TOKEN'],
        { flights: 'No flight provider is connected: set DUFFEL_ACCESS_TOKEN to search flights.' },
      );
    }

    if (env.amadeus) {
      this.hotels.push(new AmadeusProvider(env.amadeus));
    } else {
      this.disable(
        'amadeus',
        'Amadeus Self-Service',
        'Set AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET to search real hotel inventory.',
        ['AMADEUS_CLIENT_ID', 'AMADEUS_CLIENT_SECRET'],
        { hotels: 'No hotel provider is connected: set AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET to search real rooms and rates.' },
      );
    }

    const hb = env.hotelbeds;
    const hbClient = (creds: { apiKey: string; secret: string }) =>
      new HotelbedsClient(creds, hb.environment, hb.minIntervalMs);
    if (hb.hotels) {
      this.hotels.push(new HotelbedsHotelsProvider(hbClient(hb.hotels)));
    } else {
      this.disable(
        'hotelbeds-hotels',
        'Hotelbeds Hotels',
        'Set HOTELBEDS_API_KEY and HOTELBEDS_SECRET (or HOTELBEDS_HOTELS_API_KEY and HOTELBEDS_HOTELS_SECRET) to search Hotelbeds hotels.',
        ['HOTELBEDS_API_KEY', 'HOTELBEDS_SECRET'],
        { hotels: 'Hotelbeds Hotels is not connected: set HOTELBEDS_API_KEY and HOTELBEDS_SECRET to search its rooms and rates.' },
      );
    }
    if (hb.activities) {
      this.activities.push(new HotelbedsActivitiesProvider(hbClient(hb.activities)));
    } else {
      this.disable(
        'hotelbeds-activities',
        'Hotelbeds Activities',
        'Set HOTELBEDS_API_KEY and HOTELBEDS_SECRET (or HOTELBEDS_ACTIVITIES_API_KEY and HOTELBEDS_ACTIVITIES_SECRET) to search bookable activities.',
        ['HOTELBEDS_API_KEY', 'HOTELBEDS_SECRET'],
        { activities: 'Hotelbeds Activities is not connected: set HOTELBEDS_API_KEY and HOTELBEDS_SECRET to include bookable tours and tickets.' },
      );
    }
    if (hb.transfers) {
      this.quotedTransfers.push(new HotelbedsTransfersProvider(hbClient(hb.transfers)));
    } else {
      this.disable(
        'hotelbeds-transfers',
        'Hotelbeds Transfers',
        'Set HOTELBEDS_API_KEY and HOTELBEDS_SECRET (or HOTELBEDS_TRANSFERS_API_KEY and HOTELBEDS_TRANSFERS_SECRET) to quote airport transfers.',
        ['HOTELBEDS_API_KEY', 'HOTELBEDS_SECRET'],
        { transfers: 'Hotelbeds Transfers is not connected, so airport transfers are estimated from routing and tariffs instead of quoted.' },
      );
    }

    if (env.rail) {
      this.rail.push(
        new GenericRailProvider({
          ...env.rail,
          requiredEnv: ['RAIL_PROVIDER_URL'],
          attribution: null,
        }),
      );
    } else {
      this.disable(
        'rail',
        'Rail provider',
        'No rail provider is connected. Point RAIL_PROVIDER_URL at a service you are authorised to use that implements the surface-transport contract in docs/providers.md.',
        ['RAIL_PROVIDER_URL'],
        { trains: 'No rail provider is connected, so trains were not searched. Point RAIL_PROVIDER_URL at a service you are authorised to use (contract in docs/providers.md).' },
      );
    }

    if (env.bus) {
      this.buses.push(
        new GenericBusProvider({
          ...env.bus,
          requiredEnv: ['BUS_PROVIDER_URL'],
          attribution: null,
        }),
      );
    } else {
      this.disable(
        'bus',
        'Bus provider',
        'No bus provider is connected. Point BUS_PROVIDER_URL at a service you are authorised to use that implements the surface-transport contract in docs/providers.md.',
        ['BUS_PROVIDER_URL'],
        {
          buses: env.busFare
            ? 'No live bus provider is connected; bus fares are estimated from your configured assumptions (BUS_FARE_ESTIMATE) and no bus service is confirmed.'
            : 'No bus provider is connected and no bus fare assumptions are configured (BUS_FARE_ESTIMATE), so buses were not searched.',
        },
      );
    }

    // With more than one routing provider, a drive is measured by the preferred
    // one and falls back to the next, and says so when it does.
    const primaryRouting = this.routing.length > 1 ? new FallbackRoutingProvider(this.routing, this.policy) : this.routing[0];
    if (primaryRouting) {
      this.selfDrive = new SelfDriveProvider(primaryRouting, env.selfDriveProfile);
      this.groundTransport.push(new OsrmTransferProvider(primaryRouting, env.taxiTariffs, env.autoTariffs));
      // Bus fares are estimated only while no real bus provider is connected.
      if (!env.bus && env.busFare) this.buses.push(new BusEstimateProvider(primaryRouting, env.busFare));
    }
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, extras: RegistryExtras = {}): ProviderRegistry {
    return new ProviderRegistry(loadProvidersEnv(env), undefined, extras);
  }

  private disable(
    id: string,
    label: string,
    reason: string,
    requiredEnv: string[],
    capabilities: DisabledProvider['capabilities'] = {},
  ): void {
    this.disabled.push({ id, label, reason, requiredEnv, capabilities });
  }

  /** Rail/bus adapters are usually country-scoped; skip ones that cannot help. */
  railFor(countryCode: string): RailProvider[] {
    return this.rail.filter((p) => covers(p, countryCode));
  }

  busesFor(countryCode: string): BusProvider[] {
    return this.buses.filter((p) => covers(p, countryCode));
  }

  /**
   * The note the UI shows when a capability has no provider at all. It says
   * what is missing *for that capability*: Flights come from Duffel and Hotels
   * from Amadeus, and a message about one must not stand in for the other.
   */
  missingCapabilityNote(capability: ProviderCapability, ids: string[]): ProviderFailure {
    const label = CAPABILITY_LABEL[capability];
    const specific = this.disabled
      .filter((d) => ids.includes(d.id))
      .map((d) => d.capabilities[capability])
      .filter((m): m is string => Boolean(m));
    return {
      status: 'not_configured',
      provider: ids.join(','),
      providerLabel: label,
      capability,
      message: specific.length ? specific.join(' ') : `No adapter is registered for ${label.toLowerCase()}.`,
      occurredAt: new Date().toISOString(),
    };
  }

  all(): BaseProvider[] {
    const set = new Set<BaseProvider>([
      ...this.geocoding,
      ...this.flights,
      ...this.hotels,
      ...this.rail,
      ...this.buses,
      ...this.routing,
      ...this.groundTransport,
      ...this.quotedTransfers,
      ...this.activities,
    ]);
    return [...set];
  }

  async healthReport(): Promise<
    Array<{ id: string; label: string; kinds: string[]; result: ProviderResult<{ ok: true; latencyMs: number }> }>
  > {
    const providers = this.all();
    const results = await Promise.all(
      providers.map(async (p) => ({
        id: p.descriptor.id,
        label: p.descriptor.label,
        kinds: p.descriptor.kinds as string[],
        result: await p.health(),
      })),
    );
    return results;
  }
}
