import {
  fail,
  money,
  ok,
  type Coordinates,
  type FareClass,
  type HotelOffer,
  type HotelRoomOffer,
  type ProviderProvenance,
  type ProviderResult,
  type TransportOffer,
  type TransportSegment,
} from '@trip/shared';
import { httpJson, RequestPacer, toProviderFailure } from '../http.js';
import type {
  FlightProvider,
  FlightSearchRequest,
  HotelProvider,
  HotelSearchRequest,
  ProviderDescriptor,
} from '../types.js';

/**
 * Amadeus Self-Service adapter: flights and hotels.
 *
 * The test environment returns a cached subset of real inventory, so results
 * are genuine offers but not necessarily bookable. That distinction is carried
 * through in the provenance `providerLabel` so the UI can say which environment
 * a price came from instead of implying live production availability.
 */

const FLIGHT_DESCRIPTOR = (env: string): ProviderDescriptor => ({
  id: 'amadeus',
  label: env === 'production' ? 'Amadeus' : 'Amadeus (test environment)',
  kinds: ['flight', 'hotel'],
  requiredEnv: ['AMADEUS_CLIENT_ID', 'AMADEUS_CLIENT_SECRET'],
  coverage: 'global',
  docsUrl: 'https://developers.amadeus.com/self-service',
  attribution: 'Flight and hotel content provided by Amadeus',
});

export interface AmadeusConfig {
  clientId: string;
  clientSecret: string;
  environment: 'test' | 'production';
  minIntervalMs: number;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

interface AmadeusFlightOffer {
  id: string;
  itineraries: Array<{
    duration: string;
    segments: Array<{
      departure: { iataCode: string; terminal?: string; at: string };
      arrival: { iataCode: string; terminal?: string; at: string };
      carrierCode: string;
      number: string;
      aircraft?: { code: string };
      duration?: string;
      numberOfStops?: number;
    }>;
  }>;
  price: {
    currency: string;
    total: string;
    base?: string;
    grandTotal?: string;
    fees?: Array<{ amount: string; type: string }>;
  };
  numberOfBookableSeats?: number;
  validatingAirlineCodes?: string[];
  travelerPricings?: Array<{
    price: { total: string; currency: string };
    fareDetailsBySegment: Array<{
      cabin?: string;
      class?: string;
      includedCheckedBags?: { quantity?: number; weight?: number };
    }>;
  }>;
  pricingOptions?: { refundableFare?: boolean };
}

interface AmadeusHotel {
  hotelId: string;
  name: string;
  geoCode: { latitude: number; longitude: number };
  address?: { countryCode?: string; lines?: string[]; cityName?: string };
  rating?: string;
  amenities?: string[];
  distance?: { value: number; unit: string };
}

interface AmadeusHotelOffer {
  hotel: {
    hotelId: string;
    name: string;
    rating?: string;
    latitude?: number;
    longitude?: number;
    cityCode?: string;
    amenities?: string[];
    address?: { lines?: string[]; cityName?: string };
  };
  available: boolean;
  offers: Array<{
    id: string;
    checkInDate: string;
    checkOutDate: string;
    rateFamilyEstimated?: { code?: string; type?: string };
    boardType?: string;
    room?: {
      type?: string;
      typeEstimated?: { category?: string; beds?: number; bedType?: string };
      description?: { text?: string };
    };
    guests?: { adults?: number };
    price: {
      currency: string;
      base?: string;
      total: string;
      taxes?: Array<{ included?: boolean }>;
    };
    policies?: {
      cancellations?: Array<{ deadline?: string; description?: { text?: string }; amount?: string }>;
      paymentType?: string;
      refundable?: { cancellationRefund?: string };
    };
  }>;
}

export class AmadeusProvider implements FlightProvider, HotelProvider {
  readonly descriptor: ProviderDescriptor;
  private readonly baseUrl: string;
  private readonly pacer: RequestPacer;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: AmadeusConfig) {
    this.descriptor = FLIGHT_DESCRIPTOR(config.environment);
    this.baseUrl =
      config.environment === 'production'
        ? 'https://api.amadeus.com'
        : 'https://test.api.amadeus.com';
    this.pacer = new RequestPacer(config.minIntervalMs);
  }

  isConfigured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  async health(): Promise<ProviderResult<{ ok: true; latencyMs: number }>> {
    if (!this.isConfigured()) return this.notConfigured();
    const started = Date.now();
    try {
      await this.accessToken();
      return ok({ ok: true as const, latencyMs: Date.now() - started }, this.provenance());
    } catch (err) {
      return toProviderFailure(err, this.descriptor.id, this.descriptor.label);
    }
  }

  // ---------------------------------------------------------------- flights

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

    try {
      const res = await this.get<{ data: AmadeusFlightOffer[]; dictionaries?: { carriers?: Record<string, string> } }>(
        '/v2/shopping/flight-offers',
        {
          originLocationCode: originCode,
          destinationLocationCode: destinationCode,
          departureDate: req.departureDate,
          returnDate: req.returnDate ?? undefined,
          adults: req.party.adults,
          children: req.party.children || undefined,
          infants: req.party.infants || undefined,
          travelClass: req.cabinClass ? req.cabinClass.toUpperCase() : undefined,
          nonStop: req.maxStops === 0 ? true : undefined,
          currencyCode: req.currency,
          includedAirlineCodes: req.preferredCarriers.length
            ? req.preferredCarriers.join(',')
            : undefined,
          excludedAirlineCodes: req.excludedCarriers.length
            ? req.excludedCarriers.join(',')
            : undefined,
          maxPrice: req.maxPrice ?? undefined,
          max: req.limit,
        },
      );

      const carriers = res.dictionaries?.carriers ?? {};
      const offers = res.data.map((o) => this.toTransportOffer(o, carriers, req.party));
      if (offers.length === 0) {
        return fail(
          'no_availability',
          this.descriptor.id,
          this.descriptor.label,
          `No flights were returned for ${originCode} to ${destinationCode} on ${req.departureDate}.`,
        );
      }
      return ok(offers, this.provenance(`${originCode}-${destinationCode}-${req.departureDate}`));
    } catch (err) {
      return toProviderFailure(err, this.descriptor.id, this.descriptor.label);
    }
  }

  /**
   * Amadeus pricing confirms the fare is still sellable and returns the
   * current total. Any difference from the quoted price is surfaced as a
   * `price_changed` failure so the booking machine can ask the traveller
   * before charging a different amount.
   */
  async revalidateFlight(offerId: string, token: string): Promise<ProviderResult<TransportOffer>> {
    if (!this.isConfigured()) return this.notConfigured();
    let payload: AmadeusFlightOffer;
    try {
      payload = JSON.parse(token) as AmadeusFlightOffer;
    } catch {
      return fail(
        'invalid_request',
        this.descriptor.id,
        this.descriptor.label,
        'This offer can no longer be re-priced because its provider payload is missing. Search again to get a current price.',
      );
    }
    try {
      const res = await this.post<{ data: { flightOffers: AmadeusFlightOffer[] } }>(
        '/v1/shopping/flight-offers/pricing',
        { data: { type: 'flight-offers-pricing', flightOffers: [payload] } },
      );
      const priced = res.data.flightOffers[0];
      if (!priced) {
        return fail(
          'booking_unavailable',
          this.descriptor.id,
          this.descriptor.label,
          'Amadeus no longer offers this fare. Choose another option.',
        );
      }
      const party = inferParty(payload);
      return ok(this.toTransportOffer(priced, {}, party), this.provenance(offerId));
    } catch (err) {
      return toProviderFailure(err, this.descriptor.id, this.descriptor.label);
    }
  }

  /** Nearest airports for a coordinate, used to give a place an IATA code. */
  async nearestAirports(
    coords: Coordinates,
    radiusKm = 300,
  ): Promise<
    ProviderResult<
      Array<{ iataCode: string; name: string; distanceKm: number; coordinates: Coordinates | null }>
    >
  > {
    if (!this.isConfigured()) return this.notConfigured();
    try {
      const res = await this.get<{
        data: Array<{
          iataCode: string;
          name: string;
          geoCode?: { latitude: number; longitude: number };
          distance?: { value: number; unit: string };
        }>;
      }>('/v1/reference-data/locations/airports', {
        latitude: coords.lat,
        longitude: coords.lon,
        radius: Math.min(radiusKm, 500),
        'page[limit]': 5,
        sort: 'distance',
      });
      const airports = res.data
        .filter((a) => a.iataCode)
        .map((a) => ({
          iataCode: a.iataCode,
          name: a.name,
          distanceKm:
            a.distance?.unit === 'MILE' ? (a.distance.value ?? 0) * 1.609 : a.distance?.value ?? 0,
          coordinates: a.geoCode
            ? { lat: a.geoCode.latitude, lon: a.geoCode.longitude }
            : null,
        }));
      if (airports.length === 0) {
        return fail(
          'no_availability',
          this.descriptor.id,
          this.descriptor.label,
          'No airport was found within range of this location.',
        );
      }
      return ok(airports, this.provenance());
    } catch (err) {
      return toProviderFailure(err, this.descriptor.id, this.descriptor.label);
    }
  }

  // ----------------------------------------------------------------- hotels

  async searchHotels(req: HotelSearchRequest): Promise<ProviderResult<HotelOffer[]>> {
    if (!this.isConfigured()) return this.notConfigured();
    const centre = req.near ?? req.destination.coordinates;

    try {
      const list = await this.get<{ data: AmadeusHotel[] }>(
        '/v1/reference-data/locations/hotels/by-geocode',
        {
          latitude: centre.lat,
          longitude: centre.lon,
          radius: Math.max(1, Math.round(req.radiusKm)),
          radiusUnit: 'KM',
          ratings: req.minCategory ? ratingsAtOrAbove(req.minCategory).join(',') : undefined,
          hotelSource: 'ALL',
        },
      );
      const hotelIds = list.data.slice(0, 40).map((h) => h.hotelId);
      if (hotelIds.length === 0) {
        return fail(
          'no_availability',
          this.descriptor.id,
          this.descriptor.label,
          `No properties are listed within ${req.radiusKm}km of the searched area.`,
        );
      }

      const geoById = new Map(list.data.map((h) => [h.hotelId, h]));
      const offersRes = await this.get<{ data: AmadeusHotelOffer[]; warnings?: Array<{ detail?: string }> }>(
        '/v3/shopping/hotel-offers',
        {
          hotelIds: hotelIds.join(','),
          adults: Math.max(1, req.party.adults),
          checkInDate: req.checkIn,
          checkOutDate: req.checkOut,
          roomQuantity: req.rooms,
          currency: req.currency,
          bestRateOnly: false,
          priceRange: req.maxPricePerNight ? `0-${req.maxPricePerNight}` : undefined,
        },
      );

      const hotels = offersRes.data
        .filter((h) => h.available && h.offers.length > 0)
        .map((h) => this.toHotelOffer(h, geoById.get(h.hotel.hotelId), req))
        .filter((h): h is HotelOffer => h !== null)
        .slice(0, req.limit);

      if (hotels.length === 0) {
        return fail(
          'no_availability',
          this.descriptor.id,
          this.descriptor.label,
          `No rooms are available for ${req.checkIn} to ${req.checkOut} in this area at the requested occupancy.`,
        );
      }

      const warnings = (offersRes.warnings ?? [])
        .map((w) => w.detail)
        .filter((d): d is string => Boolean(d));
      return ok(hotels, this.provenance(`${req.checkIn}-${req.checkOut}`), warnings);
    } catch (err) {
      return toProviderFailure(err, this.descriptor.id, this.descriptor.label);
    }
  }

  async revalidateHotel(offerId: string): Promise<ProviderResult<HotelOffer>> {
    if (!this.isConfigured()) return this.notConfigured();
    try {
      const res = await this.get<{ data: AmadeusHotelOffer }>(`/v3/shopping/hotel-offers/${offerId}`, {});
      const hotel = this.toHotelOffer(res.data, undefined, null);
      if (!hotel) {
        return fail(
          'booking_unavailable',
          this.descriptor.id,
          this.descriptor.label,
          'This room is no longer available at the quoted rate.',
        );
      }
      return ok(hotel, this.provenance(offerId));
    } catch (err) {
      return toProviderFailure(err, this.descriptor.id, this.descriptor.label);
    }
  }

  // ---------------------------------------------------------------- mapping

  private toTransportOffer(
    o: AmadeusFlightOffer,
    carriers: Record<string, string>,
    party: { adults: number; children: number; infants: number },
  ): TransportOffer {
    const segments: TransportSegment[] = o.itineraries.flatMap((it) =>
      it.segments.map((s) => ({
        mode: 'flight' as const,
        operatorCode: s.carrierCode,
        operatorName: carriers[s.carrierCode] ?? null,
        serviceNumber: `${s.carrierCode}${s.number}`,
        origin: {
          code: s.departure.iataCode,
          name: s.departure.iataCode,
          coordinates: null,
          timezone: null,
          terminal: s.departure.terminal ?? null,
        },
        destination: {
          code: s.arrival.iataCode,
          name: s.arrival.iataCode,
          coordinates: null,
          timezone: null,
          terminal: s.arrival.terminal ?? null,
        },
        departureAt: s.departure.at,
        arrivalAt: s.arrival.at,
        durationMinutes: parseIsoDuration(s.duration) ?? diffMinutes(s.departure.at, s.arrival.at),
        vehicleType: s.aircraft?.code ?? null,
      })),
    );

    const currency = o.price.currency;
    const total = money(Number(o.price.grandTotal ?? o.price.total), currency);
    const paying = Math.max(1, party.adults + party.children);
    const firstFare = o.travelerPricings?.[0]?.fareDetailsBySegment?.[0];

    const fareClasses: FareClass[] = firstFare?.cabin
      ? [
          {
            code: firstFare.class ?? firstFare.cabin,
            label: humaniseCabin(firstFare.cabin),
            cabin: normaliseCabin(firstFare.cabin),
            price: total,
            availability: o.numberOfBookableSeats ?? null,
            availabilityLabel:
              o.numberOfBookableSeats !== undefined
                ? `${o.numberOfBookableSeats} seat(s) bookable at this fare`
                : null,
            refundable: o.pricingOptions?.refundableFare ?? null,
            checkedBagsIncluded: firstFare.includedCheckedBags?.quantity ?? null,
            cabinBagKg: null,
          },
        ]
      : [];

    const itineraryCount = o.itineraries.length;
    const transfers = o.itineraries.reduce((acc, it) => acc + Math.max(0, it.segments.length - 1), 0);
    const overnight = o.itineraries.some((it) => {
      const first = it.segments[0];
      const last = it.segments[it.segments.length - 1];
      return Boolean(first && last && first.departure.at.slice(0, 10) !== last.arrival.at.slice(0, 10));
    });

    return {
      id: `amadeus-flight:${o.id}`,
      mode: 'flight',
      segments,
      totalPrice: total,
      pricePerTraveler: money(Number(o.price.grandTotal ?? o.price.total) / paying, currency),
      itemisedFees: (o.price.fees ?? [])
        .filter((f) => Number(f.amount) > 0)
        .map((f) => ({ label: humaniseFee(f.type), amount: money(Number(f.amount), currency), included: true })),
      fareClasses,
      selectedFareCode: fareClasses[0]?.code ?? null,
      totalDurationMinutes: o.itineraries.reduce(
        (acc, it) => acc + (parseIsoDuration(it.duration) ?? 0),
        0,
      ),
      transfers: itineraryCount > 1 ? transfers : transfers,
      overnight,
      refundable: o.pricingOptions?.refundableFare ?? null,
      cancellationPolicy: null,
      baggageSummary:
        firstFare?.includedCheckedBags?.quantity !== undefined
          ? `${firstFare.includedCheckedBags.quantity} checked bag(s) included per traveller`
          : null,
      // The full offer payload is the only accepted input to Amadeus pricing,
      // so it is carried along verbatim for revalidation.
      revalidationToken: JSON.stringify(o),
      provenance: this.provenance(o.id),
    };
  }

  private toHotelOffer(
    h: AmadeusHotelOffer,
    geo: AmadeusHotel | undefined,
    req: HotelSearchRequest | null,
  ): HotelOffer | null {
    const lat = h.hotel.latitude ?? geo?.geoCode.latitude;
    const lon = h.hotel.longitude ?? geo?.geoCode.longitude;
    // Without coordinates the planner cannot reason about transfer cost or
    // distance to activities, so the property is dropped rather than shown.
    if (lat === undefined || lon === undefined) return null;

    const nights = req ? nightsBetweenDates(req.checkIn, req.checkOut) : inferNights(h);
    const rooms: HotelRoomOffer[] = h.offers.map((offer) => {
      const currency = offer.price.currency;
      const total = money(Number(offer.price.total), currency);
      const cancellation = offer.policies?.cancellations?.[0];
      return {
        id: offer.id,
        description:
          offer.room?.description?.text ?? offer.room?.typeEstimated?.category ?? 'Room',
        roomType: offer.room?.typeEstimated?.category ?? offer.room?.type ?? null,
        beds:
          offer.room?.typeEstimated?.beds !== undefined
            ? `${offer.room.typeEstimated.beds} ${offer.room.typeEstimated.bedType ?? 'bed'}`
            : null,
        maxOccupancy: offer.guests?.adults ?? null,
        boardType: offer.boardType ?? null,
        breakfastIncluded: offer.boardType ? /BREAKFAST/i.test(offer.boardType) : null,
        refundable: cancellation ? cancellation.amount === undefined || Number(cancellation.amount) === 0 : null,
        cancellationDeadline: cancellation?.deadline ?? null,
        cancellationPolicy: cancellation?.description?.text ?? null,
        totalPrice: total,
        pricePerNight: money(Number(offer.price.total) / Math.max(1, nights), currency),
        taxesIncluded: offer.price.taxes?.some((t) => t.included === true) ?? null,
        revalidationToken: offer.id,
      };
    });

    if (rooms.length === 0) return null;

    return {
      id: `amadeus-hotel:${h.hotel.hotelId}`,
      name: h.hotel.name,
      propertyType: null,
      category: h.hotel.rating ? Number(h.hotel.rating) : geo?.rating ? Number(geo.rating) : null,
      guestRating: null,
      guestRatingCount: null,
      coordinates: { lat, lon },
      address: (h.hotel.address?.lines ?? geo?.address?.lines ?? []).join(', ') || null,
      neighbourhood: h.hotel.address?.cityName ?? geo?.address?.cityName ?? null,
      amenities: h.hotel.amenities ?? geo?.amenities ?? [],
      checkInTime: null,
      checkOutTime: null,
      rooms,
      images: [],
      provenance: this.provenance(h.hotel.hotelId),
    };
  }

  // ------------------------------------------------------------- transport

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const res = await httpJson<TokenResponse>(`${this.baseUrl}/v1/security/oauth2/token`, {
      method: 'POST',
      form: true,
      body: {
        grant_type: 'client_credentials',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      },
      retries: 1,
    });
    this.token = { value: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 };
    return this.token.value;
  }

  private async get<T>(path: string, query: Record<string, unknown>): Promise<T> {
    const token = await this.accessToken();
    return this.pacer.run(() =>
      httpJson<T>(`${this.baseUrl}${path}`, {
        query: query as Record<string, string | number | boolean | undefined>,
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: 20_000,
      }),
    );
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const token = await this.accessToken();
    return this.pacer.run(() =>
      httpJson<T>(`${this.baseUrl}${path}`, {
        method: 'POST',
        body,
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: 25_000,
        retries: 0,
      }),
    );
  }

  private notConfigured() {
    return fail(
      'not_configured',
      this.descriptor.id,
      this.descriptor.label,
      'Amadeus is not configured. Set AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET to search real flight and hotel inventory.',
    );
  }

  private provenance(searchId: string | null = null): ProviderProvenance {
    return {
      provider: this.descriptor.id,
      providerLabel: this.descriptor.label,
      retrievedAt: new Date().toISOString(),
      // Amadeus does not publish a fare hold; 20 minutes is the operator-set
      // window after which this planner insists on re-pricing before booking.
      validUntil: new Date(Date.now() + 20 * 60_000).toISOString(),
      searchId,
      attribution: this.descriptor.attribution,
    };
  }
}

// -------------------------------------------------------------- helpers

function pickIata(place: { iataCityCode?: string; airports: Array<{ iataCode: string }> }): string | null {
  return place.iataCityCode ?? place.airports[0]?.iataCode ?? null;
}

export function parseIsoDuration(d: string | undefined): number | null {
  if (!d) return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?$/.exec(d);
  if (!m) return null;
  const [, days, hours, minutes] = m;
  return Number(days ?? 0) * 1440 + Number(hours ?? 0) * 60 + Number(minutes ?? 0);
}

function diffMinutes(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 60_000);
}

function nightsBetweenDates(a: string, b: string): number {
  return Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000));
}

function inferNights(h: AmadeusHotelOffer): number {
  const o = h.offers[0];
  if (!o) return 1;
  return nightsBetweenDates(o.checkInDate, o.checkOutDate);
}

function inferParty(o: AmadeusFlightOffer): { adults: number; children: number; infants: number } {
  const count = o.travelerPricings?.length ?? 1;
  return { adults: count, children: 0, infants: 0 };
}

function normaliseCabin(cabin: string): 'economy' | 'premium_economy' | 'business' | 'first' | null {
  switch (cabin.toUpperCase()) {
    case 'ECONOMY':
      return 'economy';
    case 'PREMIUM_ECONOMY':
      return 'premium_economy';
    case 'BUSINESS':
      return 'business';
    case 'FIRST':
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

function humaniseFee(type: string): string {
  return type === 'SUPPLIER' ? 'Supplier fee' : type === 'TICKETING' ? 'Ticketing fee' : type;
}

function ratingsAtOrAbove(min: number): number[] {
  const out: number[] = [];
  for (let r = Math.ceil(min); r <= 5; r += 1) out.push(r);
  return out;
}
