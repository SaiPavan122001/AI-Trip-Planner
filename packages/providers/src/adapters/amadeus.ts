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
import { InvalidResponseError, httpJson, RequestPacer, toProviderFailure } from '../http.js';
import { droppedWarning, readItems, readResponse } from '../guard.js';
import {
  AmadeusAirport,
  AmadeusAirportsResponse,
  AmadeusFlightOffer,
  AmadeusFlightSearchResponse,
  AmadeusHotel,
  AmadeusHotelListResponse,
  AmadeusHotelOffer,
  AmadeusHotelOffersResponse,
  AmadeusPricingResponse,
  AmadeusSingleHotelOfferResponse,
  AmadeusToken,
} from '../schemas.js';
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
      const raw = await this.get<unknown>(
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
        req.signal,
      );

      const res = readResponse(AmadeusFlightSearchResponse, raw, 'flight search');
      const carriers = res.dictionaries?.carriers ?? {};
      const items = readItems(res.data, AmadeusFlightOffer);
      if (items.allInvalid) throw new InvalidResponseError('flight search', 'no offer had the documented shape');
      // Each offer keeps the payload Amadeus sent: re-pricing needs every field of it back.
      // Amadeus numbers offers within one response ("1", "2", ...), so the same number
      // comes back for the outward and the return search. The search is part of the id.
      const scope = `${originCode}-${destinationCode}-${req.departureDate}`;
      const offers = items.valid.map((o) => this.toTransportOffer(o.data, carriers, req.party, o.raw, scope));
      if (offers.length === 0) {
        return fail(
          'no_availability',
          this.descriptor.id,
          this.descriptor.label,
          `No flights were returned for ${originCode} to ${destinationCode} on ${req.departureDate}.`,
        );
      }
      return ok(
        offers,
        this.provenance(`${originCode}-${destinationCode}-${req.departureDate}`),
        droppedWarning(this.descriptor.label, items.dropped, 'flight offer(s)'),
      );
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
  async revalidateFlight(token: string): Promise<ProviderResult<TransportOffer>> {
    if (!this.isConfigured()) return this.notConfigured();
    let payload: AmadeusFlightOffer;
    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(token);
      payload = AmadeusFlightOffer.parse(rawPayload);
    } catch {
      return fail(
        'invalid_request',
        this.descriptor.id,
        this.descriptor.label,
        'This offer can no longer be re-priced because its provider payload is missing. Search again to get a current price.',
      );
    }
    try {
      const res = readResponse(
        AmadeusPricingResponse,
        await this.post<unknown>('/v1/shopping/flight-offers/pricing', {
          data: { type: 'flight-offers-pricing', flightOffers: [rawPayload] },
        }),
        'flight pricing',
      );
      const rawPriced = res.data.flightOffers[0];
      if (rawPriced === undefined) {
        return fail(
          'booking_unavailable',
          this.descriptor.id,
          this.descriptor.label,
          'Amadeus no longer offers this fare. Choose another option.',
        );
      }
      const priced = readResponse(AmadeusFlightOffer, rawPriced, 'flight pricing');
      const party = inferParty(payload);
      return ok(this.toTransportOffer(priced, {}, party, rawPriced, 'priced'), this.provenance(payload.id));
    } catch (err) {
      return toProviderFailure(err, this.descriptor.id, this.descriptor.label);
    }
  }

  /** Nearest airports for a coordinate, used to give a place an IATA code. */
  async nearestAirports(
    coords: Coordinates,
    radiusKm = 300,
    signal?: AbortSignal,
  ): Promise<
    ProviderResult<
      Array<{ iataCode: string; name: string; distanceKm: number; coordinates: Coordinates | null }>
    >
  > {
    if (!this.isConfigured()) return this.notConfigured();
    try {
      const res = readResponse(
        AmadeusAirportsResponse,
        await this.get<unknown>('/v1/reference-data/locations/airports', {
          latitude: coords.lat,
          longitude: coords.lon,
          radius: Math.min(radiusKm, 500),
          'page[limit]': 5,
          sort: 'distance',
        }, signal),
        'airport search',
      );
      const items = readItems(res.data, AmadeusAirport);
      if (items.allInvalid) throw new InvalidResponseError('airport search', 'no airport had the documented shape');
      const airports = items.valid
        .map((v) => v.data)
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
      return ok(airports, this.provenance(), droppedWarning(this.descriptor.label, items.dropped, 'airport(s)'));
    } catch (err) {
      return toProviderFailure(err, this.descriptor.id, this.descriptor.label);
    }
  }

  // ----------------------------------------------------------------- hotels

  async searchHotels(req: HotelSearchRequest): Promise<ProviderResult<HotelOffer[]>> {
    if (!this.isConfigured()) return this.notConfigured();
    const centre = req.near ?? req.destination.coordinates;

    // Amadeus takes guests per room, not for the whole booking. Sending the
    // whole party for each of several rooms asked for far more people than
    // the traveller has, and priced (or hid) rooms accordingly.
    const perRoom = guestsPerRoom(req.party, req.rooms);
    if (perRoom > MAX_GUESTS_PER_ROOM) {
      return fail(
        'invalid_request',
        this.descriptor.id,
        this.descriptor.label,
        `${perRoom} guests per room is more than a room search allows (${MAX_GUESTS_PER_ROOM}). Add rooms to search for this group.`,
      );
    }

    try {
      const listRaw = await this.get<unknown>(
        '/v1/reference-data/locations/hotels/by-geocode',
        {
          latitude: centre.lat,
          longitude: centre.lon,
          radius: Math.max(1, Math.round(req.radiusKm)),
          radiusUnit: 'KM',
          ratings: req.minCategory ? ratingsAtOrAbove(req.minCategory).join(',') : undefined,
          hotelSource: 'ALL',
        },
        req.signal,
      );
      const listed = readItems(readResponse(AmadeusHotelListResponse, listRaw, 'hotel list').data, AmadeusHotel);
      if (listed.allInvalid) throw new InvalidResponseError('hotel list', 'no property had the documented shape');
      const list = { data: listed.valid.map((v) => v.data) };
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
      const offersRaw = await this.get<unknown>(
        '/v3/shopping/hotel-offers',
        {
          hotelIds: hotelIds.join(','),
          adults: perRoom,
          checkInDate: req.checkIn,
          checkOutDate: req.checkOut,
          roomQuantity: req.rooms,
          currency: req.currency,
          bestRateOnly: false,
          priceRange: req.maxPricePerNight ? `0-${req.maxPricePerNight}` : undefined,
        },
        req.signal,
      );

      const offersRes = readResponse(AmadeusHotelOffersResponse, offersRaw, 'hotel offers');
      const offerItems = readItems(offersRes.data, AmadeusHotelOffer);
      if (offerItems.allInvalid) throw new InvalidResponseError('hotel offers', 'no offer had the documented shape');
      const hotels = offerItems.valid
        .map((v) => v.data)
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
      warnings.push(...droppedWarning(this.descriptor.label, offerItems.dropped + listed.dropped, 'property listing(s)'));
      if (req.party.children > 0) {
        // The search has no children or ages, so children are counted as
        // guests. Child rates and free-child policies are not requested.
        warnings.push(
          'Children are counted as guests when searching rooms; child ages and child rates are not requested, so prices may differ at the property.',
        );
      }
      return ok(hotels, this.provenance(`${req.checkIn}-${req.checkOut}`), warnings);
    } catch (err) {
      return toProviderFailure(err, this.descriptor.id, this.descriptor.label);
    }
  }

  /**
   * For Amadeus the hotel token is the offer id from the search. It is
   * encoded before it goes into the path, because it can arrive from a
   * client and must not be able to address a different endpoint.
   */
  async revalidateHotel(token: string): Promise<ProviderResult<HotelOffer>> {
    if (!this.isConfigured()) return this.notConfigured();
    const offerId = token;
    try {
      const res = readResponse(
        AmadeusSingleHotelOfferResponse,
        await this.get<unknown>(`/v3/shopping/hotel-offers/${encodeURIComponent(offerId)}`, {}),
        'hotel offer',
      );
      const hotel = this.toHotelOffer(readResponse(AmadeusHotelOffer, res.data, 'hotel offer'), undefined, null);
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
    rawOffer: unknown,
    scope: string,
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
      id: `amadeus-flight:${scope}:${o.id}`,
      mode: 'flight',
      segments,
      totalPrice: total,
      pricePerTraveler: money(Number(o.price.grandTotal ?? o.price.total) / paying, currency),
      itemisedFees: (o.price.fees ?? [])
        .filter((f) => Number(f.amount) > 0)
        .map((f) => ({
          label: humaniseFee(f.type),
          amount: money(Number(f.amount), currency),
          // Already inside the quoted grand total, and quoted, not modelled.
          included: true,
          isEstimate: false,
          basis: null,
        })),
      unpricedCosts: [],
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
      revalidationToken: JSON.stringify(rawOffer),
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
        // `guests.adults` is how many guests this rate was priced for, which
        // is what was asked, not how many the room sleeps. Amadeus does not
        // state room capacity, so it stays unknown rather than borrowing a
        // number that looks like one.
        maxOccupancy: null,
        boardType: offer.boardType ?? null,
        breakfastIncluded: offer.boardType ? /BREAKFAST/i.test(offer.boardType) : null,
        refundable: mapRefundable(offer.policies),
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
      category: finiteOrNull(h.hotel.rating ?? geo?.rating),
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
    const res = readResponse(
      AmadeusToken,
      await httpJson<unknown>(`${this.baseUrl}/v1/security/oauth2/token`, {
        method: 'POST',
        form: true,
        body: {
          grant_type: 'client_credentials',
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        },
        retries: 1,
      }),
      'token',
    );
    this.token = { value: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 };
    return this.token.value;
  }

  private async get<T>(path: string, query: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const token = await this.accessToken();
    return this.pacer.run(() =>
      httpJson<T>(`${this.baseUrl}${path}`, {
        query: query as Record<string, string | number | boolean | undefined>,
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: 20_000,
        ...(signal ? { signal } : {}),
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

/** Most guests per room the Amadeus hotel search accepts. */
const MAX_GUESTS_PER_ROOM = 9;

/**
 * Guests to price each room for: everyone who takes a bed (infants on a lap
 * do not), spread over the rooms, rounded up so nobody is left out.
 */
export function guestsPerRoom(party: { adults: number; children: number }, rooms: number): number {
  return Math.max(1, Math.ceil((party.adults + party.children) / Math.max(1, rooms)));
}

/**
 * Whether a rate can be cancelled for a refund, only as far as the provider
 * says so. Amadeus states this in `policies.refundable.cancellationRefund`;
 * anything else, including a policy with no amount on it, is unknown. A rate
 * whose refund deadline has already passed is no longer refundable.
 */
export function mapRefundable(
  policies: AmadeusHotelOffer['offers'][number]['policies'],
  now: Date = new Date(),
): boolean | null {
  const stated = policies?.refundable?.cancellationRefund;
  if (stated === 'NON_REFUNDABLE') return false;
  if (stated !== 'REFUNDABLE_UP_TO_DEADLINE') return null;
  const deadline = policies?.cancellations?.[0]?.deadline;
  if (deadline && Date.parse(deadline) < now.getTime()) return false;
  return true;
}

/** A rating vendors send as "4" or 4, or nothing usable. */
function finiteOrNull(value: string | number | undefined): number | null {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

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
