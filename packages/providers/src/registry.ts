import {
  CAPABILITY_LABEL,
  type ProviderCapability,
  type ProviderFailure,
  type ProviderResult,
} from '@trip/shared';
import { IsolatingPolicy, type ProviderPolicy } from './guard.js';
import { AmadeusProvider } from './adapters/amadeus.js';
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
   * traveller. One vendor can serve several (Amadeus does flights and hotels),
   * and each is reported on its own so the two are never merged into one note.
   */
  capabilities: Partial<Record<ProviderCapability, string>>;
}

export class ProviderRegistry {
  readonly geocoding: GeocodingProvider[] = [];
  readonly flights: FlightProvider[] = [];
  readonly hotels: HotelProvider[] = [];
  readonly rail: RailProvider[] = [];
  readonly buses: BusProvider[] = [];
  readonly routing: RoutingProvider[] = [];
  readonly groundTransport: GroundTransportProvider[] = [];
  readonly activities: ActivityProvider[] = [];
  /** Populated for every adapter that exists but cannot run. Surfaced in the UI. */
  readonly disabled: DisabledProvider[] = [];
  readonly selfDrive: SelfDriveProvider | null = null;
  /** Kept separately because airport lookup is an Amadeus-specific capability. */
  readonly amadeus: AmadeusProvider | null = null;
  /** Operator-configured ground tariffs, by currency. The planner uses these
   *  to model local transport cost; with none configured it models nothing. */
  readonly taxiTariffs: ProvidersEnv['taxiTariffs'];
  /**
   * Every provider call the planner makes goes through this. The default
   * isolates failures and enforces a deadline; retries, fallback, rate
   * limiting, circuit breaking, caching and metrics are policies to supply here.
   */
  readonly policy: ProviderPolicy;

  constructor(env: ProvidersEnv, policy?: ProviderPolicy) {
    this.taxiTariffs = env.taxiTariffs;
    this.policy = policy ?? new IsolatingPolicy({ deadlineMs: env.policy.callTimeoutMs });
    const nominatim = new NominatimProvider(env.nominatim);
    if (nominatim.isConfigured()) this.geocoding.push(nominatim);
    else
      this.disable(
        'nominatim',
        'OpenStreetMap Nominatim',
        'Set NOMINATIM_USER_AGENT to a contact address. The geocoder is required to resolve places and classify the journey.',
        ['NOMINATIM_USER_AGENT'],
        { geocoding: 'No place lookup is configured: set NOMINATIM_USER_AGENT to a contact address so places can be resolved and the journey classified.' },
      );

    if (env.osrm) {
      const osrmRouting = new OsrmRoutingProvider(env.osrm);
      this.routing.push(osrmRouting);
      this.groundTransport.push(new OsrmTransferProvider(osrmRouting, env.taxiTariffs));
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
      const googleRouting = new GoogleRoutesProvider(env.google);
      // Google goes first when present: traffic-aware durations are the
      // difference between a transfer that works and one that misses a flight.
      this.routing.unshift(googleRouting);
      this.activities.push(new GooglePlacesProvider(env.google));
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

    if (env.amadeus) {
      const amadeus = new AmadeusProvider(env.amadeus);
      this.amadeus = amadeus;
      this.flights.push(amadeus);
      this.hotels.push(amadeus);
    } else {
      this.disable(
        'amadeus',
        'Amadeus Self-Service',
        'Set AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET to search real flight and hotel inventory.',
        ['AMADEUS_CLIENT_ID', 'AMADEUS_CLIENT_SECRET'],
        {
          flights: 'No flight provider is connected: set AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET to search real flights.',
          hotels: 'No hotel provider is connected: set AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET to search real rooms and rates.',
        },
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
        { buses: 'No bus provider is connected, so buses were not searched. Point BUS_PROVIDER_URL at a service you are authorised to use (contract in docs/providers.md).' },
      );
    }

    const primaryRouting = this.routing[0];
    if (primaryRouting) {
      this.selfDrive = new SelfDriveProvider(primaryRouting, env.selfDriveProfile);
    }
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): ProviderRegistry {
    return new ProviderRegistry(loadProvidersEnv(env));
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
   * what is missing *for that capability*: Flights and Hotels both come from
   * Amadeus, and a message about one must not stand in for the other.
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
