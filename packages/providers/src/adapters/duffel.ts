import {
  fail,
  money,
  ok,
  type Coordinates,
  type FareClass,
  type ProviderProvenance,
  type ProviderResult,
  type TransportOffer,
  type TransportSegment,
} from '@trip/shared';
import { HttpError, InvalidResponseError, httpJson, RequestPacer, toProviderFailure } from '../http.js';
import { droppedWarning, readItems, readResponse } from '../guard.js';
import { DuffelOffer, DuffelOfferRequestResponse, DuffelPlace, DuffelPlacesResponse, DuffelSingleOfferResponse } from '../schemas.js';
import type { FlightProvider, FlightSearchRequest, ProviderDescriptor } from '../types.js';

/**
 * Duffel adapter: flight search, offer re-pricing and nearest-airport lookup.
 * Read only. It never creates an order, a payment or a hold.
 *
 * Duffel has one base URL. Test and live are told apart by the access token
 * (`duffel_test_...` / `duffel_live_...`), so `environment` here is only what
 * the operator says the token is, checked against the token by the config
 * loader, and carried into the provenance label so a price from test mode is
 * never presented as a live fare. Test mode returns Duffel's own sandbox
 * airline ("Duffel Airways", ZZ) with schedules and prices that do not
 * describe real flights.
 *
 * Docs: https://duffel.com/docs/api
 */

export const DUFFEL_BASE_URL = 'https://api.duffel.com';
/** The API version this adapter's schemas were written against. */
export const DUFFEL_VERSION = 'v2';

const DESCRIPTOR = (env: string): ProviderDescriptor => ({
  id: 'duffel',
  label: env === 'live' ? 'Duffel' : 'Duffel (test mode)',
  kinds: ['flight'],
  requiredEnv: ['DUFFEL_ACCESS_TOKEN'],
  coverage: 'global',
  docsUrl: 'https://duffel.com/docs/api',
  attribution: 'Flight content provided by Duffel',
});

export interface DuffelConfig {
  accessToken: string;
  environment: 'test' | 'live';
  minIntervalMs: number;
}

/** The most connections Duffel's `max_connections` accepts. */
const MAX_CONNECTIONS = 2;
/** How long Duffel is asked to wait for each airline, in ms. */
const SUPPLIER_TIMEOUT_MS = 15_000;

export class DuffelProvider implements FlightProvider {
  readonly descriptor: ProviderDescriptor;
  private readonly pacer: RequestPacer;

  constructor(private readonly config: DuffelConfig) {
    this.descriptor = DESCRIPTOR(config.environment);
    this.pacer = new RequestPacer(config.minIntervalMs);
  }

  isConfigured(): boolean {
    return Boolean(this.config.accessToken);
  }

  async health(): Promise<ProviderResult<{ ok: true; latencyMs: number }>> {
    if (!this.isConfigured()) return this.notConfigured();
    const started = Date.now();
    try {
      // The cheapest authenticated read there is: it spends no search.
      await this.get<unknown>('/places/suggestions', { query: 'del' });
      return ok({ ok: true as const, latencyMs: Date.now() - started }, this.provenance());
    } catch (err) {
      return this.failure(err);
    }
  }

  async searchFlights(req: FlightSearchRequest): Promise<ProviderResult<TransportOffer[]>> {
    if (!this.isConfigured()) return this.notConfigured();

    const originCode = pickIata(req.origin);
    const destinationCode = pickIata(req.destination);
    if (!originCode || !destinationCode) {
      return fail(
        'unsupported_route',
        this.descriptor.id,
        this.descriptor.label,
        `No airport code is known for ${!originCode ? req.origin.name : req.destination.name}, so flights cannot be searched for this leg.`,
      );
    }

    const slices = [{ origin: originCode, destination: destinationCode, departure_date: req.departureDate }];
    if (req.returnDate) slices.push({ origin: destinationCode, destination: originCode, departure_date: req.returnDate });

    const passengers = [
      ...Array.from({ length: req.party.adults }, () => ({ type: 'adult' })),
      ...Array.from({ length: req.party.children }, () => ({ type: 'child' })),
      ...Array.from({ length: req.party.infants }, () => ({ type: 'infant_without_seat' })),
    ];
    if (passengers.length === 0) {
      return fail('invalid_request', this.descriptor.id, this.descriptor.label, 'A flight search needs at least one traveller.');
    }

    try {
      const raw = await this.post<unknown>(
        '/air/offer_requests',
        {
          data: {
            slices,
            passengers,
            ...(req.cabinClass ? { cabin_class: req.cabinClass } : {}),
            // Left out when the traveller set no limit, so Duffel's own default (one connection) applies.
            ...(req.maxStops !== null ? { max_connections: Math.min(Math.max(req.maxStops, 0), MAX_CONNECTIONS) } : {}),
          },
        },
        { return_offers: true, supplier_timeout: SUPPLIER_TIMEOUT_MS },
        req.signal,
      );

      const res = readResponse(DuffelOfferRequestResponse, raw, 'flight search');
      const items = readItems(res.data.offers, DuffelOffer);
      if (items.allInvalid) throw new InvalidResponseError('flight search', 'no offer had the documented shape');

      const scope = `${originCode}-${destinationCode}-${req.departureDate}`;
      const preferred = new Set(req.preferredCarriers.map((c) => c.toUpperCase()));
      const excluded = new Set(req.excludedCarriers.map((c) => c.toUpperCase()));
      const offers = items.valid
        .map((o) => o.data)
        // Duffel has no carrier or price filter on a search, so those are applied here.
        .filter((o) => {
          const carriers = marketingCarriers(o);
          if (preferred.size > 0 && !carriers.some((c) => preferred.has(c))) return false;
          if (carriers.some((c) => excluded.has(c))) return false;
          if (req.maxPrice !== null && o.total_currency === req.currency && Number(o.total_amount) > req.maxPrice) return false;
          return true;
        })
        .sort((a, b) => Number(a.total_amount) - Number(b.total_amount))
        .slice(0, req.limit)
        .map((o) => this.toTransportOffer(o, req.party, scope));

      if (offers.length === 0) {
        return fail(
          'no_availability',
          this.descriptor.id,
          this.descriptor.label,
          `No flights were returned for ${originCode} to ${destinationCode} on ${req.departureDate}.`,
        );
      }
      return ok(offers, this.provenance(scope), droppedWarning(this.descriptor.label, items.dropped, 'flight offer(s)'));
    } catch (err) {
      return this.failure(err);
    }
  }

  /**
   * Re-reads one offer. Duffel keeps an offer until `expires_at`; asking for it
   * again returns its current price or an error once it is gone. A different
   * price is surfaced by the caller as a price change. This only reads: no
   * order is created.
   */
  async revalidateFlight(token: string): Promise<ProviderResult<TransportOffer>> {
    if (!this.isConfigured()) return this.notConfigured();
    // The token comes from a stored record; it is encoded so it cannot address another path.
    if (!/^off_[A-Za-z0-9_]+$/.test(token)) {
      return fail(
        'invalid_request',
        this.descriptor.id,
        this.descriptor.label,
        'This offer can no longer be re-priced because its provider reference is missing. Search again to get a current price.',
      );
    }
    try {
      const res = readResponse(
        DuffelSingleOfferResponse,
        await this.get<unknown>(`/air/offers/${encodeURIComponent(token)}`, {}),
        'flight offer',
      );
      const offer = readResponse(DuffelOffer, res.data, 'flight offer');
      // The offer states how many travellers it prices; only a per-traveller figure depends on it.
      const adults = Math.max(1, offer.passengers?.length ?? 1);
      return ok(this.toTransportOffer(offer, { adults, children: 0, infants: 0 }, 'priced'), this.provenance(offer.id, offer.expires_at ?? null));
    } catch (err) {
      if (isGone(err)) {
        return fail(
          'booking_unavailable',
          this.descriptor.id,
          this.descriptor.label,
          'Duffel no longer offers this fare. Choose another option.',
        );
      }
      return this.failure(err);
    }
  }

  /** Airports near a coordinate, nearest first, used to give a place an IATA code. */
  async nearestAirports(
    coords: Coordinates,
    radiusKm = 300,
    signal?: AbortSignal,
  ): Promise<
    ProviderResult<Array<{ iataCode: string; name: string; distanceKm: number; coordinates: Coordinates | null }>>
  > {
    if (!this.isConfigured()) return this.notConfigured();
    try {
      const res = readResponse(
        DuffelPlacesResponse,
        await this.get<unknown>(
          '/places/suggestions',
          { lat: coords.lat, lng: coords.lon, rad: Math.round(Math.min(radiusKm, 500) * 1000) },
          signal,
        ),
        'airport search',
      );
      const items = readItems(res.data, DuffelPlace);
      if (items.allInvalid) throw new InvalidResponseError('airport search', 'no place had the documented shape');
      const airports = items.valid
        .map((v) => v.data)
        .filter((p) => p.type === 'airport')
        .map((p) => {
          const at = p.latitude != null && p.longitude != null ? { lat: p.latitude, lon: p.longitude } : null;
          return {
            iataCode: p.iata_code,
            name: p.name,
            distanceKm: at ? Math.round(distanceKm(coords, at) * 10) / 10 : 0,
            coordinates: at,
          };
        })
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, 5);
      if (airports.length === 0) {
        return fail('no_availability', this.descriptor.id, this.descriptor.label, 'No airport was found within range of this location.');
      }
      return ok(airports, this.provenance(), droppedWarning(this.descriptor.label, items.dropped, 'place(s)'));
    } catch (err) {
      return this.failure(err);
    }
  }

  // ---------------------------------------------------------------- mapping

  private toTransportOffer(
    o: DuffelOffer,
    party: { adults: number; children: number; infants: number },
    scope: string,
  ): TransportOffer {
    const segments: TransportSegment[] = o.slices.flatMap((slice) =>
      slice.segments.map((s) => ({
        mode: 'flight' as const,
        operatorCode: s.marketing_carrier.iata_code ?? null,
        operatorName: s.marketing_carrier.name ?? null,
        serviceNumber: `${s.marketing_carrier.iata_code ?? ''}${s.marketing_carrier_flight_number}`,
        origin: endpoint(s.origin, s.origin_terminal),
        destination: endpoint(s.destination, s.destination_terminal),
        departureAt: s.departing_at,
        arrivalAt: s.arriving_at,
        durationMinutes: parseIsoDuration(s.duration) ?? diffMinutes(s.departing_at, s.arriving_at),
        vehicleType: s.aircraft?.iata_code ?? s.aircraft?.name ?? null,
      })),
    );

    const currency = o.total_currency;
    const total = money(Number(o.total_amount), currency);
    const paying = Math.max(1, party.adults + party.children);
    const first = o.slices[0]?.segments[0]?.passengers?.[0];
    const checkedBags = first?.baggages?.find((b) => b.type === 'checked')?.quantity;
    const refund = o.conditions?.refund_before_departure ?? null;
    const refundable = refund ? refund.allowed : null;
    const cabin = normaliseCabin(first?.cabin_class);

    const fareClasses: FareClass[] = first?.cabin_class
      ? [
          {
            code: first.fare_basis_code ?? first.cabin_class,
            label: first.cabin_class_marketing_name ?? humaniseCabin(first.cabin_class),
            cabin,
            price: total,
            availability: null,
            availabilityLabel: null,
            refundable,
            checkedBagsIncluded: checkedBags ?? null,
            cabinBagKg: null,
          },
        ]
      : [];

    const transfers = o.slices.reduce((acc, sl) => acc + Math.max(0, sl.segments.length - 1), 0);
    const overnight = o.slices.some((sl) => {
      const firstSeg = sl.segments[0];
      const lastSeg = sl.segments[sl.segments.length - 1];
      return Boolean(firstSeg && lastSeg && firstSeg.departing_at.slice(0, 10) !== lastSeg.arriving_at.slice(0, 10));
    });

    return {
      id: `duffel-flight:${scope}:${o.id}`,
      mode: 'flight',
      segments,
      totalPrice: total,
      pricePerTraveler: money(Number(o.total_amount) / paying, currency),
      itemisedFees: [],
      unpricedCosts: [],
      fareClasses,
      selectedFareCode: fareClasses[0]?.code ?? null,
      totalDurationMinutes: o.slices.reduce(
        (acc, sl) =>
          acc +
          (parseIsoDuration(sl.duration) ??
            sl.segments.reduce((n, seg) => n + (parseIsoDuration(seg.duration) ?? diffMinutes(seg.departing_at, seg.arriving_at)), 0)),
        0,
      ),
      transfers,
      overnight,
      refundable,
      cancellationPolicy: refundPolicyText(refund),
      baggageSummary: checkedBags !== undefined ? `${checkedBags} checked bag(s) included per traveller` : null,
      // Duffel re-reads an offer by its id alone.
      revalidationToken: o.id,
      provenance: this.provenance(o.id, o.expires_at ?? null),
    };
  }

  // ------------------------------------------------------------- transport

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.accessToken}`,
      'Duffel-Version': DUFFEL_VERSION,
      Accept: 'application/json',
    };
  }

  private get<T>(path: string, query: Record<string, string | number | boolean | undefined>, signal?: AbortSignal): Promise<T> {
    return this.pacer.run(
      () =>
        httpJson<T>(`${DUFFEL_BASE_URL}${path}`, {
          query,
          headers: this.headers(),
          timeoutMs: 20_000,
          ...(signal ? { signal } : {}),
        }),
      signal,
    );
  }

  /** A search is a POST that creates an offer request; it is not repeated automatically. */
  private post<T>(
    path: string,
    body: unknown,
    query: Record<string, string | number | boolean | undefined>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.pacer.run(
      () =>
        httpJson<T>(`${DUFFEL_BASE_URL}${path}`, {
          method: 'POST',
          body,
          query,
          headers: this.headers(),
          timeoutMs: 30_000,
          retries: 0,
          ...(signal ? { signal } : {}),
        }),
      signal,
    );
  }

  /**
   * Duffel says exactly what was wrong with a refused request (a missing
   * permission, an unknown token). That is passed on in place of a generic
   * "credentials rejected", because the fix differs: a token without flight
   * search permission needs a new token, not a different key. Duffel's error
   * text never contains the token.
   */
  private failure(err: unknown) {
    const generic = toProviderFailure(err, this.descriptor.id, this.descriptor.label);
    if (!(err instanceof HttpError) || (err.status !== 401 && err.status !== 403)) return generic;
    const first = duffelError(err.body);
    if (first?.code === 'insufficient_permissions') {
      const permission = /'([a-z_.]+)'/.exec(first.message ?? '')?.[1] ?? 'air.offer_requests.create';
      return {
        ...generic,
        message: `The Duffel token is not allowed to search flights: it lacks the '${permission}' permission. Create a token with flight search access in the Duffel dashboard (Developers > Access tokens) and put it in DUFFEL_ACCESS_TOKEN.`,
      };
    }
    if (first?.code) {
      return { ...generic, message: `Duffel refused the request (${first.code}). Check DUFFEL_ACCESS_TOKEN and DUFFEL_ENVIRONMENT.` };
    }
    return generic;
  }

  private notConfigured() {
    return fail(
      'not_configured',
      this.descriptor.id,
      this.descriptor.label,
      'Duffel is not configured. Set DUFFEL_ACCESS_TOKEN to search flights.',
    );
  }

  private provenance(searchId: string | null = null, expiresAt: string | null = null): ProviderProvenance {
    return {
      provider: this.descriptor.id,
      providerLabel: this.descriptor.label,
      retrievedAt: new Date().toISOString(),
      // Duffel states when an offer lapses; otherwise a short window after which re-pricing is insisted on.
      validUntil: expiresAt ?? new Date(Date.now() + 20 * 60_000).toISOString(),
      searchId,
      attribution: this.descriptor.attribution,
    };
  }
}

// -------------------------------------------------------------- helpers

function pickIata(place: { iataCityCode?: string; airports: Array<{ iataCode: string }> }): string | null {
  return place.iataCityCode ?? place.airports[0]?.iataCode ?? null;
}

function marketingCarriers(o: DuffelOffer): string[] {
  return o.slices.flatMap((sl) => sl.segments.map((s) => (s.marketing_carrier.iata_code ?? '').toUpperCase())).filter(Boolean);
}

function endpoint(a: DuffelOffer['slices'][number]['segments'][number]['origin'], terminal: string | null | undefined) {
  return {
    code: a.iata_code,
    name: a.name ?? a.iata_code,
    coordinates: a.latitude != null && a.longitude != null ? { lat: a.latitude, lon: a.longitude } : null,
    timezone: a.time_zone ?? null,
    terminal: terminal ?? null,
  };
}

/** Only what Duffel states; no amount means the penalty is not stated. */
function refundPolicyText(refund: { allowed: boolean; penalty_amount?: string | null; penalty_currency?: string | null } | null): string | null {
  if (!refund) return null;
  if (!refund.allowed) return 'Not refundable before departure.';
  if (refund.penalty_amount && refund.penalty_currency) {
    return `Refundable before departure with a penalty of ${refund.penalty_amount} ${refund.penalty_currency}.`;
  }
  return 'Refundable before departure.';
}

/** The first entry of Duffel's documented `errors` list, if the body has one. */
function duffelError(body: string): { code?: string; message?: string } | null {
  try {
    const parsed = JSON.parse(body) as { errors?: Array<{ code?: unknown; message?: unknown }> };
    const e = parsed.errors?.[0];
    if (!e) return null;
    return {
      ...(typeof e.code === 'string' && /^[a-z_]{1,60}$/.test(e.code) ? { code: e.code } : {}),
      ...(typeof e.message === 'string' ? { message: e.message.slice(0, 300) } : {}),
    };
  } catch {
    return null;
  }
}

/** A 404 or 410 from Duffel for an offer means it has expired or never existed. */
function isGone(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 404 || status === 410;
}

export function parseIsoDuration(d: string | null | undefined): number | null {
  if (!d) return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?$/.exec(d);
  if (!m) return null;
  const [, days, hours, minutes] = m;
  return Number(days ?? 0) * 1440 + Number(hours ?? 0) * 60 + Number(minutes ?? 0);
}

/** Only used when Duffel gives no duration; both times are local, so across time zones this is approximate. */
function diffMinutes(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 60_000);
}

function distanceKm(a: Coordinates, b: Coordinates): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function normaliseCabin(cabin: string | null | undefined): 'economy' | 'premium_economy' | 'business' | 'first' | null {
  switch (cabin?.toLowerCase()) {
    case 'economy':
      return 'economy';
    case 'premium_economy':
      return 'premium_economy';
    case 'business':
      return 'business';
    case 'first':
      return 'first';
    default:
      return null;
  }
}

function humaniseCabin(cabin: string): string {
  return cabin
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
