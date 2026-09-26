import type {
  ActivityOffer,
  Coordinates,
  HotelOffer,
  IsoDate,
  Place,
  ProviderResult,
  TransferOffer,
  TransportOffer,
} from '@trip/shared';

/**
 * Provider contracts. Every adapter in this package implements one or more of
 * these interfaces and nothing else in the system knows about vendor APIs.
 *
 * Two rules hold for every implementation:
 *  1. Return a ProviderFailure rather than partial or invented data.
 *  2. Attach provenance (source + retrieval time) to everything returned.
 */

export type ProviderKind =
  | 'geocoding'
  | 'flight'
  | 'hotel'
  | 'rail'
  | 'bus'
  | 'ground_transport'
  | 'car_rental'
  | 'activity'
  | 'routing';

export interface ProviderDescriptor {
  id: string;
  label: string;
  kinds: ProviderKind[];
  /** Env vars required to enable the adapter, listed in setup docs and errors. */
  requiredEnv: string[];
  /** Countries the adapter serves, or 'global'. Used to skip pointless calls. */
  coverage: 'global' | string[];
  docsUrl: string | null;
  /** Attribution string the provider's terms require to be displayed. */
  attribution: string | null;
}

export interface BaseProvider {
  readonly descriptor: ProviderDescriptor;
  /** False when credentials are missing. The registry then skips the adapter
   *  and records a `not_configured` note instead of calling it. */
  isConfigured(): boolean;
  /** Cheap liveness probe used by /providers/health. */
  health(): Promise<ProviderResult<{ ok: true; latencyMs: number }>>;
}

export interface GeocodingProvider extends BaseProvider {
  /** Resolve free text to candidate places, best match first. */
  resolvePlace(query: string, opts?: { limit?: number }): Promise<ProviderResult<Place[]>>;
  reverse(coords: Coordinates): Promise<ProviderResult<Place>>;
}

export interface PartySize {
  adults: number;
  children: number;
  infants: number;
}

export interface FlightSearchRequest {
  origin: Place;
  destination: Place;
  departureDate: IsoDate;
  returnDate: IsoDate | null;
  party: PartySize;
  cabinClass: 'economy' | 'premium_economy' | 'business' | 'first' | null;
  maxStops: number | null;
  preferredCarriers: string[];
  excludedCarriers: string[];
  currency: string;
  /** Hard ceiling passed to the provider where supported, to cut noise. */
  maxPrice: number | null;
  limit: number;
  /** Stops the search, and any waiting or retrying, when it fires. */
  signal?: AbortSignal;
}

export interface FlightProvider extends BaseProvider {
  searchFlights(req: FlightSearchRequest): Promise<ProviderResult<TransportOffer[]>>;
  /**
   * Re-price a specific offer immediately before booking. Takes only the
   * provider's own revalidation token, exactly as the search returned it.
   * Nothing from this system's own records, such as a booking id, may be
   * passed here: a provider cannot interpret it, and mixing the two up is
   * how a request ends up naming an offer that does not exist.
   */
  revalidateFlight(token: string): Promise<ProviderResult<TransportOffer>>;
}

export interface HotelSearchRequest {
  destination: Place;
  checkIn: IsoDate;
  checkOut: IsoDate;
  rooms: number;
  party: PartySize;
  minCategory: number | null;
  maxPricePerNight: number | null;
  currency: string;
  amenities: string[];
  freeCancellationOnly: boolean;
  /** Bias results toward this point (usually the activity centroid). */
  near: Coordinates | null;
  radiusKm: number;
  limit: number;
  signal?: AbortSignal;
}

export interface HotelProvider extends BaseProvider {
  searchHotels(req: HotelSearchRequest): Promise<ProviderResult<HotelOffer[]>>;
  /** As `revalidateFlight`: the provider's own token, and nothing internal. */
  revalidateHotel(token: string): Promise<ProviderResult<HotelOffer>>;
}

export interface SurfaceSearchRequest {
  origin: Place;
  destination: Place;
  date: IsoDate;
  party: PartySize;
  currency: string;
  /** Provider-specific class filter, passed through untranslated. */
  classCode: string | null;
  limit: number;
  signal?: AbortSignal;
}

/** Rail and bus share a shape but stay separate interfaces: their class
 *  taxonomies and booking flows have nothing in common. */
export interface RailProvider extends BaseProvider {
  searchTrains(req: SurfaceSearchRequest): Promise<ProviderResult<TransportOffer[]>>;
}

export interface BusProvider extends BaseProvider {
  searchBuses(req: SurfaceSearchRequest): Promise<ProviderResult<TransportOffer[]>>;
}

export interface RouteRequest {
  from: Coordinates;
  to: Coordinates;
  profile: 'driving' | 'walking' | 'cycling';
  departAt?: string;
  signal?: AbortSignal;
}

export interface RouteResult {
  distanceKm: number;
  durationMinutes: number;
  /** Encoded polyline when the provider returns one, for the map view. */
  geometry: string | null;
}

export interface RoutingProvider extends BaseProvider {
  route(req: RouteRequest): Promise<ProviderResult<RouteResult>>;
}

export interface TransferSearchRequest {
  from: { name: string; coordinates: Coordinates };
  to: { name: string; coordinates: Coordinates };
  at: string;
  party: PartySize;
  luggagePieces: number;
  accessibleRequired: boolean;
  currency: string;
}

export interface GroundTransportProvider extends BaseProvider {
  searchTransfers(req: TransferSearchRequest): Promise<ProviderResult<TransferOffer[]>>;
}

export interface CarRentalSearchRequest {
  pickup: Place;
  dropoff: Place;
  pickupAt: string;
  dropoffAt: string;
  driverAge: number | null;
  currency: string;
}

export interface CarRentalProvider extends BaseProvider {
  searchCars(req: CarRentalSearchRequest): Promise<ProviderResult<TransportOffer[]>>;
}

export interface ActivitySearchRequest {
  destination: Place;
  near: Coordinates;
  radiusKm: number;
  categories: string[];
  /** Filters out activities a member of the party cannot access. */
  accessibilityNeeds: string[];
  currency: string;
  limit: number;
  signal?: AbortSignal;
}

export interface ActivityProvider extends BaseProvider {
  searchActivities(req: ActivitySearchRequest): Promise<ProviderResult<ActivityOffer[]>>;
}

export type AnyProvider =
  | GeocodingProvider
  | FlightProvider
  | HotelProvider
  | RailProvider
  | BusProvider
  | RoutingProvider
  | GroundTransportProvider
  | CarRentalProvider
  | ActivityProvider;

export function supports(p: BaseProvider, kind: ProviderKind): boolean {
  return p.descriptor.kinds.includes(kind);
}

/** Coverage check, so a country-specific adapter is not called for a route it
 *  cannot serve (which would burn a rate-limit slot to return nothing). */
export function covers(p: BaseProvider, countryCode: string): boolean {
  const c = p.descriptor.coverage;
  return c === 'global' || c.includes(countryCode.toUpperCase());
}
