import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AmadeusProvider, guestsPerRoom, mapRefundable } from '../adapters/amadeus.js';
import type { HotelSearchRequest } from '../types.js';

/**
 * Amadeus hotel mapping, against fixtures shaped like its responses. The
 * rule throughout: state only what the provider states. Silence stays
 * unknown; it is never turned into a guarantee.
 */

type Policies = NonNullable<Parameters<typeof mapRefundable>[0]>;
const NOW = new Date('2026-06-01T00:00:00Z');

describe('refundability', () => {
  it('is true only when the provider says the rate is refundable', () => {
    const policies: Policies = { refundable: { cancellationRefund: 'REFUNDABLE_UP_TO_DEADLINE' } };
    expect(mapRefundable(policies, NOW)).toBe(true);
  });

  it('is false when the provider says it is not', () => {
    expect(mapRefundable({ refundable: { cancellationRefund: 'NON_REFUNDABLE' } }, NOW)).toBe(false);
  });

  it('stays unknown when a cancellation is listed with no amount', () => {
    // The old mapping read a missing amount as "free to cancel".
    const policies: Policies = { cancellations: [{ deadline: '2026-07-01T00:00:00Z' }] };
    expect(mapRefundable(policies, NOW)).toBeNull();
  });

  it('stays unknown with no policy, or a value it does not recognise', () => {
    expect(mapRefundable(undefined, NOW)).toBeNull();
    expect(mapRefundable({}, NOW)).toBeNull();
    expect(mapRefundable({ refundable: { cancellationRefund: 'SOMETHING_NEW' } }, NOW)).toBeNull();
  });

  it('is no longer refundable once the refund deadline has passed', () => {
    const policies: Policies = {
      refundable: { cancellationRefund: 'REFUNDABLE_UP_TO_DEADLINE' },
      cancellations: [{ deadline: '2026-05-01T00:00:00Z' }],
    };
    expect(mapRefundable(policies, NOW)).toBe(false);
  });
});

describe('guests per room', () => {
  it('spreads the party over the rooms, rounding up', () => {
    expect(guestsPerRoom({ adults: 4, children: 0 }, 2)).toBe(2);
    expect(guestsPerRoom({ adults: 3, children: 2 }, 2)).toBe(3);
    expect(guestsPerRoom({ adults: 1, children: 0 }, 1)).toBe(1);
  });

  it('never returns less than one, even with a bad room count', () => {
    expect(guestsPerRoom({ adults: 2, children: 0 }, 0)).toBe(2);
  });
});

// ------------------------------------------------------------ the adapter

const provider = () =>
  new AmadeusProvider({ clientId: 'test-id', clientSecret: 'test-secret', environment: 'test', minIntervalMs: 0 });

const request = (overrides: Partial<HotelSearchRequest> = {}): HotelSearchRequest => ({
  destination: {
    id: 'p', name: 'Bengaluru', displayName: 'Bengaluru', coordinates: { lat: 12.97, lon: 77.59 },
    countryCode: 'IN', countryName: 'India', timezone: 'Asia/Kolkata', airports: [], source: 'test',
    resolvedAt: '2026-01-01T00:00:00.000Z',
  },
  checkIn: '2026-11-10',
  checkOut: '2026-11-14',
  rooms: 1,
  party: { adults: 2, children: 0, infants: 0 },
  minCategory: null,
  maxPricePerNight: null,
  currency: 'INR',
  amenities: [],
  freeCancellationOnly: false,
  near: null,
  radiusKm: 10,
  limit: 10,
  ...overrides,
});

const offer = (policies: unknown) => ({
  hotel: { hotelId: 'TESTHTL1', name: 'Test Hotel', rating: '4', latitude: 12.97, longitude: 77.59, amenities: [] },
  available: true,
  offers: [
    {
      id: 'OFFER-ABC-1',
      checkInDate: '2026-11-10',
      checkOutDate: '2026-11-14',
      guests: { adults: 2 },
      price: { currency: 'INR', total: '24000.00' },
      policies,
    },
  ],
});

let offerSearchParams: URLSearchParams | null = null;

function stubAmadeus(hotelOffer: unknown) {
  offerSearchParams = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.pathname.endsWith('/oauth2/token')) return json({ access_token: 'test-token', expires_in: 1799 });
      if (url.pathname.endsWith('/hotels/by-geocode')) return json({ data: [{ hotelId: 'TESTHTL1', name: 'Test Hotel', geoCode: { latitude: 12.97, longitude: 77.59 } }] });
      if (url.pathname.endsWith('/hotel-offers')) {
        offerSearchParams = url.searchParams;
        return json({ data: [hotelOffer] });
      }
      return new Response('{}', { status: 404 });
    }),
  );
}

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.unstubAllGlobals());

describe('the Amadeus hotel search', () => {
  it('asks for guests per room, not the whole party for each room', async () => {
    stubAmadeus(offer({}));
    await provider().searchHotels(request({ rooms: 2, party: { adults: 4, children: 0, infants: 0 } }));

    expect(offerSearchParams?.get('adults')).toBe('2');
    expect(offerSearchParams?.get('roomQuantity')).toBe('2');
  });

  it('refuses a search that would need more guests per room than a room allows', async () => {
    stubAmadeus(offer({}));
    const res = await provider().searchHotels(request({ rooms: 1, party: { adults: 12, children: 0, infants: 0 } }));

    expect(res.status).toBe('invalid_request');
    expect(offerSearchParams).toBeNull();
  });

  it('says children are counted as guests rather than priced separately', async () => {
    stubAmadeus(offer({}));
    const res = await provider().searchHotels(request({ party: { adults: 2, children: 2, infants: 0 } }));

    expect(offerSearchParams?.get('adults')).toBe('4');
    expect(res.status === 'ok' && res.warnings.join(' ')).toMatch(/Children are counted as guests/);
  });

  it('does not count a lap infant as a guest', async () => {
    stubAmadeus(offer({}));
    await provider().searchHotels(request({ party: { adults: 2, children: 0, infants: 1 } }));
    expect(offerSearchParams?.get('adults')).toBe('2');
  });

  it('leaves room capacity unknown instead of using the guests the rate was priced for', async () => {
    stubAmadeus(offer({}));
    const res = await provider().searchHotels(request());

    if (res.status !== 'ok') throw new Error(res.message);
    expect(res.data[0]!.rooms[0]!.maxOccupancy).toBeNull();
  });

  it('keeps refundability unknown for a rate whose cancellation has no stated refund', async () => {
    stubAmadeus(offer({ cancellations: [{ deadline: '2030-01-01T00:00:00Z', description: { text: 'Cancel before deadline' } }] }));
    const res = await provider().searchHotels(request());

    if (res.status !== 'ok') throw new Error(res.message);
    expect(res.data[0]!.rooms[0]!.refundable).toBeNull();
    expect(res.data[0]!.rooms[0]!.cancellationPolicy).toBe('Cancel before deadline');
  });

  it('carries the provider offer id, not any internal id', async () => {
    stubAmadeus(offer({ refundable: { cancellationRefund: 'NON_REFUNDABLE' } }));
    const res = await provider().searchHotels(request());

    if (res.status !== 'ok') throw new Error(res.message);
    const room = res.data[0]!.rooms[0]!;
    expect(room.id).toBe('OFFER-ABC-1');
    expect(room.revalidationToken).toBe('OFFER-ABC-1');
    expect(room.refundable).toBe(false);
  });
});

describe('hotel re-pricing', () => {
  it('asks Amadeus about the offer id it was given, encoded into the path', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        urls.push(url.pathname);
        const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
        if (url.pathname.endsWith('/oauth2/token')) return json({ access_token: 'test-token', expires_in: 1799 });
        return json({ data: offer({ refundable: { cancellationRefund: 'NON_REFUNDABLE' } }) });
      }),
    );

    const res = await provider().revalidateHotel('OFFER-ABC-1');
    expect(res.status).toBe('ok');
    expect(urls).toContain('/v3/shopping/hotel-offers/OFFER-ABC-1');
  });

  it('cannot be pointed at a different endpoint by a crafted token', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        urls.push(url.pathname);
        if (url.pathname.endsWith('/oauth2/token')) {
          return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 1799 }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      }),
    );

    await provider().revalidateHotel('../../v1/security/oauth2/token');
    expect(urls.filter((p) => p.includes('/hotel-offers/'))).toEqual([
      '/v3/shopping/hotel-offers/..%2F..%2Fv1%2Fsecurity%2Foauth2%2Ftoken',
    ]);
  });
});
