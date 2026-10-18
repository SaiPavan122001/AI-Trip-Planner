import {
  fail,
  money,
  ok,
  type Coordinates,
  type HotelOffer,
  type HotelRoomOffer,
  type Money,
  type ProviderProvenance,
  type ProviderResult,
} from '@trip/shared';
import { InvalidResponseError, toProviderFailure } from '../http.js';
import { droppedWarning, readItems, readResponse } from '../guard.js';
import {
  HotelbedsAvailabilityResponse,
  HotelbedsCheckRateResponse,
  HotelbedsContentHotel,
  HotelbedsContentResponse,
  HotelbedsHotel,
  HotelbedsRate,
} from '../schemas.js';
import type { HotelProvider, HotelSearchRequest, ProviderDescriptor } from '../types.js';
import type { HotelbedsClient } from './hotelbeds-client.js';

/**
 * Hotelbeds Hotel API (APItude): availability, rate re-check, and descriptive
 * content. Read only: it never calls `/bookings`.
 *
 *  - Availability: `POST /hotel-api/1.0/hotels` with a stay, occupancies and a
 *    geolocation. Dynamic: prices, rooms, boards, cancellation terms.
 *  - Re-check: `POST /hotel-api/1.0/checkrates` with a rate key.
 *  - Content: `GET /hotel-content-api/1.0/hotels`. Static: descriptions and
 *    address. Kept apart from the rates, cached for a day, and best effort: a
 *    failure there never fails a search or touches a price.
 *
 * Prices are in the currency of the account's contract (the `currency` of
 * each hotel). This planner works in rupees only, so a hotel quoted in
 * another currency is passed on as it is and set aside by the planner; it is
 * never converted here.
 */

const DESCRIPTOR = (env: string): ProviderDescriptor => ({
  id: 'hotelbeds-hotels',
  label: env === 'live' ? 'Hotelbeds Hotels' : 'Hotelbeds Hotels (test account)',
  kinds: ['hotel'],
  requiredEnv: ['HOTELBEDS_API_KEY', 'HOTELBEDS_SECRET'],
  coverage: 'global',
  docsUrl: 'https://developer.hotelbeds.com/documentation/hotels/',
  attribution: 'Hotel content and rates provided by Hotelbeds',
});

const MAX_GUESTS_PER_ROOM = 9;
const CONTENT_TTL_MS = 24 * 60 * 60 * 1000;
const CONTENT_BATCH = 100;

interface Content {
  description: string | null;
  address: string | null;
  city: string | null;
  at: number;
}

export class HotelbedsHotelsProvider implements HotelProvider {
  readonly descriptor: ProviderDescriptor;
  private readonly content = new Map<string, Content>();

  constructor(private readonly client: HotelbedsClient) {
    this.descriptor = DESCRIPTOR(client.environment);
  }

  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  /** `GET /hotel-api/1.0/status` is Hotelbeds' own documented liveness call. */
  async health(): Promise<ProviderResult<{ ok: true; latencyMs: number }>> {
    if (!this.isConfigured()) return this.notConfigured();
    const started = Date.now();
    try {
      await this.client.get<unknown>('/hotel-api/1.0/status');
      return ok({ ok: true as const, latencyMs: Date.now() - started }, this.provenance());
    } catch (err) {
      return toProviderFailure(err, this.descriptor.id, this.descriptor.label);
    }
  }

  async searchHotels(req: HotelSearchRequest): Promise<ProviderResult<HotelOffer[]>> {
    if (!this.isConfigured()) return this.notConfigured();
    const centre = req.near ?? req.destination.coordinates;

    // Hotelbeds prices rooms by occupancy, and a child needs an age, which this
    // planner does not collect. Everyone who takes a bed is counted as an adult
    // and the traveller is told.
    const perRoom = Math.max(1, Math.ceil((req.party.adults + req.party.children) / Math.max(1, req.rooms)));
    if (perRoom > MAX_GUESTS_PER_ROOM) {
      return fail(
        'invalid_request',
        this.descriptor.id,
        this.descriptor.label,
        `${perRoom} guests per room is more than a room search allows (${MAX_GUESTS_PER_ROOM}). Add rooms to search for this group.`,
      );
    }

    try {
      const raw = await this.client.post<unknown>(
        '/hotel-api/1.0/hotels',
        {
          stay: { checkIn: req.checkIn, checkOut: req.checkOut },
          occupancies: [{ rooms: req.rooms, adults: perRoom, children: 0 }],
          geolocation: {
            latitude: centre.lat,
            longitude: centre.lon,
            radius: Math.max(1, Math.round(req.radiusKm)),
            unit: 'km',
          },
        },
        req.signal,
      );

      const res = readResponse(HotelbedsAvailabilityResponse, raw, 'hotel availability');
      const listed = res.hotels?.hotels ?? [];
      const items = readItems(listed, HotelbedsHotel);
      if (items.allInvalid) throw new InvalidResponseError('hotel availability', 'no property had the documented shape');

      const warnings: string[] = [];
      let recheck = 0;
      const offers: HotelOffer[] = [];
      let droppedRates = 0;
      for (const { data: h } of items.valid) {
        const mapped = this.toHotelOffer(h, nightsBetween(req.checkIn, req.checkOut));
        droppedRates += mapped.droppedRates;
        recheck += mapped.recheck;
        if (!mapped.offer) continue;
        if (req.minCategory !== null && mapped.offer.category !== null && mapped.offer.category < req.minCategory) continue;
        if (req.maxPricePerNight !== null) {
          const room = mapped.offer.rooms.filter(
            (r) => r.pricePerNight.currency !== req.currency || r.pricePerNight.amount <= money(req.maxPricePerNight!, req.currency).amount,
          );
          if (room.length === 0) continue;
          offers.push({ ...mapped.offer, rooms: room });
        } else {
          offers.push(mapped.offer);
        }
      }

      if (offers.length === 0) {
        return fail(
          'no_availability',
          this.descriptor.id,
          this.descriptor.label,
          `No rooms are available for ${req.checkIn} to ${req.checkOut} in this area at the requested occupancy.`,
        );
      }

      const chosen = spread(offers, req.limit);
      warnings.push(...(await this.addContent(chosen, req.signal)));
      warnings.push(...droppedWarning(this.descriptor.label, items.dropped + droppedRates, 'property or rate listing(s)'));
      if (req.party.children > 0) {
        warnings.push(
          'Children are counted as adults when searching rooms because child ages are not collected, so prices may differ at the property.',
        );
      }
      if (recheck > 0) {
        warnings.push(
          `${recheck} rate(s) are marked by Hotelbeds as needing a re-check before they can be treated as current; this is done when a room is chosen.`,
        );
      }
      if (this.client.environment !== 'live') {
        warnings.push('These rates come from the Hotelbeds test account and are not live inventory.');
      }
      return ok(chosen, this.provenance(`${req.checkIn}-${req.checkOut}`), warnings);
    } catch (err) {
      return toProviderFailure(err, this.descriptor.id, this.descriptor.label);
    }
  }

  /**
   * Re-checks one rate with `POST /hotel-api/1.0/checkrates`. The token is the
   * one the search handed out (the rate key, with the property's position, which
   * the re-check answer may not repeat); nothing else is ever sent.
   */
  async revalidateHotel(token: string): Promise<ProviderResult<HotelOffer>> {
    if (!this.isConfigured()) return this.notConfigured();
    const parsed = parseToken(token);
    if (!parsed) {
      return fail(
        'invalid_request',
        this.descriptor.id,
        this.descriptor.label,
        'This room can no longer be re-checked because its provider reference is missing. Search again to get a current price.',
      );
    }
    try {
      const res = readResponse(
        HotelbedsCheckRateResponse,
        await this.client.post<unknown>('/hotel-api/1.0/checkrates', { rooms: [{ rateKey: parsed.rateKey }] }),
        'rate check',
      );
      const hotel = readResponse(HotelbedsHotel, res.hotel, 'rate check');
      const mapped = this.toHotelOffer(hotel, parsed.nights, parsed.position);
      if (!mapped.offer) {
        return fail(
          'booking_unavailable',
          this.descriptor.id,
          this.descriptor.label,
          'This room is no longer available at the quoted rate.',
        );
      }
      return ok(mapped.offer, this.provenance(parsed.rateKey));
    } catch (err) {
      return toProviderFailure(err, this.descriptor.id, this.descriptor.label);
    }
  }

  // ---------------------------------------------------------------- mapping

  private toHotelOffer(
    h: HotelbedsHotel,
    nights: number,
    fallbackPosition: Coordinates | null = null,
  ): { offer: HotelOffer | null; droppedRates: number; recheck: number } {
    const lat = h.latitude != null ? Number(h.latitude) : fallbackPosition?.lat;
    const lon = h.longitude != null ? Number(h.longitude) : fallbackPosition?.lon;
    let droppedRates = 0;
    let recheck = 0;
    // Without a position the planner cannot reason about transfers or distance
    // to activities, so the property is left out rather than placed at a guess.
    if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return { offer: null, droppedRates, recheck };
    }

    const position = { lat, lon };
    const rooms: HotelRoomOffer[] = [];
    for (const room of h.rooms) {
      const rates = readItems(room.rates, HotelbedsRate);
      droppedRates += rates.dropped;
      rates.valid.forEach(({ data: rate }, index) => {
        if (rate.rateType === 'RECHECK') recheck += 1;
        rooms.push(this.toRoom(h, room, rate, index, nights, position));
      });
    }
    if (rooms.length === 0) return { offer: null, droppedRates, recheck };

    const code = String(h.code);
    return {
      offer: {
        id: `hotelbeds-hotel:${code}`,
        name: h.name,
        propertyType: null,
        description: this.content.get(code)?.description ?? null,
        category: stars(h.categoryCode),
        guestRating: null,
        guestRatingCount: null,
        coordinates: position,
        address: this.content.get(code)?.address ?? null,
        neighbourhood: h.zoneName ?? h.destinationName ?? null,
        // Facilities come back as codes that need a separate lookup; they are
        // not requested, so none are claimed.
        amenities: [],
        checkInTime: null,
        checkOutTime: null,
        rooms,
        images: [],
        provenance: this.provenance(code),
      },
      droppedRates,
      recheck,
    };
  }

  private toRoom(
    h: HotelbedsHotel,
    room: HotelbedsHotel['rooms'][number],
    rate: HotelbedsRate,
    index: number,
    nights: number,
    position: Coordinates,
  ): HotelRoomOffer {
    const currency = h.currency;
    // A rate covers `rooms` identical rooms; the planner multiplies one room's
    // price by the room count, so each figure is brought down to one room.
    const roomsInRate = rate.rooms ?? 1;
    // When Hotelbeds says the selling price must be shown (`hotelMandatory`)
    // it is sent as `sellingRate`; otherwise `net` is the price of the stay.
    const stayTotal = Number(rate.sellingRate ?? rate.net);
    const perRoom = stayTotal / roomsInRate;
    const total = money(perRoom, currency);

    const taxes = rate.taxes?.taxes ?? [];
    const unpaid = taxes.filter((t) => t.included === false);
    const dueAmount = unpaid
      .filter((t) => t.amount != null && (t.currency ?? currency) === currency)
      .reduce((sum, t) => sum + Number(t.amount), 0);
    const payAtProperty: Money | null = dueAmount > 0 ? money(dueAmount / roomsInRate, currency) : null;
    const taxesIncluded =
      rate.taxes?.allIncluded === true ? true : unpaid.length > 0 ? false : taxes.length > 0 ? true : null;

    const policies = (rate.cancellationPolicies ?? []).slice().sort((a, b) => a.from.localeCompare(b.from));
    const refundable = refundability(rate);
    const first = policies[0];

    return {
      id: `hb:${h.code}:${room.code}:${index}`,
      description: room.name ?? room.code,
      roomType: room.name ?? room.code,
      beds: null,
      maxOccupancy: null,
      boardType: rate.boardName ?? rate.boardCode ?? null,
      breakfastIncluded: breakfast(rate.boardCode),
      refundable,
      cancellationDeadline: refundable === true ? (first?.from ?? null) : null,
      cancellationPolicy: policies.length
        ? policies.map((p) => `From ${p.from}: ${p.amount} ${currency} is charged`).join('; ')
        : null,
      totalPrice: total,
      pricePerNight: money(perRoom / Math.max(1, nights), currency),
      taxesIncluded,
      payAtProperty,
      revalidationToken: JSON.stringify({ v: 1, rateKey: rate.rateKey, nights, position }),
    };
  }

  // ---------------------------------------------------------------- content

  /** Fills in descriptions and addresses from the content service. Never touches a price. */
  private async addContent(offers: HotelOffer[], signal?: AbortSignal): Promise<string[]> {
    const wanted = offers.map((o) => o.id.replace('hotelbeds-hotel:', ''));
    const missing = wanted.filter((code) => {
      const c = this.content.get(code);
      return !c || Date.now() - c.at > CONTENT_TTL_MS;
    });
    const warnings: string[] = [];
    if (missing.length > 0) {
      try {
        for (let i = 0; i < missing.length; i += CONTENT_BATCH) {
          const batch = missing.slice(i, i + CONTENT_BATCH);
          const raw = await this.client.get<unknown>(
            '/hotel-content-api/1.0/hotels',
            { codes: batch.join(','), fields: 'all', language: 'ENG', from: 1, to: batch.length },
            signal,
          );
          const list = readResponse(HotelbedsContentResponse, raw, 'hotel content').hotels ?? [];
          for (const { data } of readItems(list, HotelbedsContentHotel).valid) {
            this.content.set(String(data.code), {
              description: data.description?.content ?? null,
              address: data.address?.content ?? null,
              city: data.city?.content ?? null,
              at: Date.now(),
            });
          }
        }
      } catch {
        // Descriptions are a courtesy; a search is not worth failing over them.
        warnings.push('Hotel descriptions could not be loaded from Hotelbeds right now; prices and rooms are unaffected.');
      }
    }
    for (const offer of offers) {
      const c = this.content.get(offer.id.replace('hotelbeds-hotel:', ''));
      if (!c) continue;
      offer.description = c.description;
      offer.address = c.address ? [c.address, c.city].filter(Boolean).join(', ') : offer.address;
    }
    return warnings;
  }

  private notConfigured() {
    return fail(
      'not_configured',
      this.descriptor.id,
      this.descriptor.label,
      'Hotelbeds Hotels is not configured. Set HOTELBEDS_API_KEY and HOTELBEDS_SECRET (or the HOTELBEDS_HOTELS_* pair) to search hotels.',
    );
  }

  private provenance(searchId: string | null = null): ProviderProvenance {
    return {
      provider: this.descriptor.id,
      providerLabel: this.descriptor.label,
      retrievedAt: new Date().toISOString(),
      // Hotelbeds states no hold for a search result; this is the window after
      // which the planner insists on a re-check.
      validUntil: new Date(Date.now() + 20 * 60_000).toISOString(),
      searchId,
      attribution: this.descriptor.attribution,
    };
  }
}

// -------------------------------------------------------------- helpers

/** Stars from a Hotelbeds category code: "4EST" and "5LUX" are 4 and 5; "H3_5" is 3.5; "HS", "APTH" and the like are unrated. */
export function stars(code: string | null | undefined): number | null {
  if (!code) return null;
  const whole = /^(\d)(?:EST|LUX)/.exec(code);
  if (whole) return Number(whole[1]);
  const half = /^H(\d)_5$/.exec(code);
  if (half) return Number(half[1]) + 0.5;
  return null;
}

/** Board codes: RO is room only; BB, HB, FB and AI include breakfast. Anything else is not claimed. */
function breakfast(code: string | null | undefined): boolean | null {
  if (!code) return null;
  if (code === 'RO') return false;
  return ['BB', 'HB', 'FB', 'AI'].includes(code) ? true : null;
}

/** NRF is Hotelbeds' non-refundable class. A normal rate with stated charges is refundable up to the first charge date; anything else is not claimed. */
function refundability(rate: HotelbedsRate): boolean | null {
  if (rate.rateClass === 'NRF') return false;
  if (rate.rateClass === 'NOR' && (rate.cancellationPolicies?.length ?? 0) > 0) {
    const first = rate.cancellationPolicies!.map((p) => p.from).sort()[0]!;
    return Date.parse(first) > Date.now() ? true : false;
  }
  return null;
}

function nightsBetween(a: string, b: string): number {
  return Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000));
}

function parseToken(token: string): { rateKey: string; nights: number; position: Coordinates } | null {
  try {
    const t = JSON.parse(token) as { v?: number; rateKey?: unknown; nights?: unknown; position?: { lat?: unknown; lon?: unknown } };
    if (t.v !== 1 || typeof t.rateKey !== 'string' || t.rateKey === '') return null;
    const lat = Number(t.position?.lat);
    const lon = Number(t.position?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { rateKey: t.rateKey, nights: Math.max(1, Number(t.nights) || 1), position: { lat, lon } };
  } catch {
    return null;
  }
}

/**
 * Keeps at most `limit` properties spread evenly from the cheapest to the
 * dearest, so a budget stay and a premium or luxury one are all in the set the
 * planner chooses from. Cutting the list at the cheapest would remove them.
 */
function spread(offers: HotelOffer[], limit: number): HotelOffer[] {
  const price = (o: HotelOffer) => Math.min(...o.rooms.map((r) => r.totalPrice.amount));
  const sorted = [...offers].sort((a, b) => price(a) - price(b));
  if (sorted.length <= limit) return sorted;
  const out: HotelOffer[] = [];
  for (let i = 0; i < limit; i += 1) {
    out.push(sorted[Math.round((i * (sorted.length - 1)) / Math.max(1, limit - 1))]!);
  }
  return [...new Set(out)];
}
