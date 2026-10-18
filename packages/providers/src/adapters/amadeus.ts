import {
  SingleFlight,
  fail,
  money,
  ok,
  type HotelOffer,
  type HotelRoomOffer,
  type ProviderProvenance,
  type ProviderResult,
} from '@trip/shared';
import { InvalidResponseError, httpJson, RequestPacer, toProviderFailure } from '../http.js';
import { droppedWarning, readItems, readResponse } from '../guard.js';
import {
  AmadeusHotel,
  AmadeusHotelListResponse,
  AmadeusHotelOffer,
  AmadeusHotelOffersResponse,
  AmadeusSingleHotelOfferResponse,
  AmadeusToken,
} from '../schemas.js';
import type {
  HotelProvider,
  HotelSearchRequest,
  ProviderDescriptor,
} from '../types.js';

/**
 * Amadeus Self-Service adapter: hotels. (Flights moved to Duffel; see duffel.ts.)
 *
 * The test environment returns a cached subset of real inventory, so results
 * are genuine offers but not necessarily bookable. That distinction is carried
 * through in the provenance `providerLabel` so the UI can say which environment
 * a price came from instead of implying live production availability.
 */

const DESCRIPTOR = (env: string): ProviderDescriptor => ({
  id: 'amadeus',
  label: env === 'production' ? 'Amadeus' : 'Amadeus (test environment)',
  kinds: ['hotel'],
  requiredEnv: ['AMADEUS_CLIENT_ID', 'AMADEUS_CLIENT_SECRET'],
  coverage: 'global',
  docsUrl: 'https://developers.amadeus.com/self-service',
  attribution: 'Hotel content provided by Amadeus',
});

export interface AmadeusConfig {
  clientId: string;
  clientSecret: string;
  environment: 'test' | 'production';
  minIntervalMs: number;
}

export class AmadeusProvider implements HotelProvider {
  readonly descriptor: ProviderDescriptor;
  private readonly baseUrl: string;
  private readonly pacer: RequestPacer;
  private token: { value: string; expiresAt: number } | null = null;
  private readonly tokenFlight = new SingleFlight<string>();

  constructor(private readonly config: AmadeusConfig) {
    this.descriptor = DESCRIPTOR(config.environment);
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
        payAtProperty: null,
        revalidationToken: offer.id,
      };
    });

    if (rooms.length === 0) return null;

    return {
      id: `amadeus-hotel:${h.hotel.hotelId}`,
      name: h.hotel.name,
      propertyType: null,
      description: null,
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

  /**
   * One token request at a time: a search asks for a token from every call it
   * makes in parallel, and each fetching its own would be a burst of identical
   * requests to an endpoint that is itself rate limited.
   */
  private accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return Promise.resolve(this.token.value);
    return this.tokenFlight.run('token', () => this.fetchToken());
  }

  private async fetchToken(): Promise<string> {
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
      'Amadeus is not configured. Set AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET to search real hotel inventory.',
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

function nightsBetweenDates(a: string, b: string): number {
  return Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000));
}

function inferNights(h: AmadeusHotelOffer): number {
  const o = h.offers[0];
  if (!o) return 1;
  return nightsBetweenDates(o.checkInDate, o.checkOutDate);
}

function ratingsAtOrAbove(min: number): number[] {
  const out: number[] = [];
  for (let r = Math.ceil(min); r <= 5; r += 1) out.push(r);
  return out;
}
