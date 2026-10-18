import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isOk, statusClass, type Place, type ProviderFailure, type ProviderResult } from '@trip/shared';
import { AmadeusProvider } from '../adapters/amadeus.js';
import { GooglePlacesProvider, GoogleRoutesProvider } from '../adapters/google-maps.js';
import { GenericRailProvider } from '../adapters/generic-surface.js';
import { NominatimProvider } from '../adapters/nominatim.js';
import { OsrmRoutingProvider, OsrmTransferProvider } from '../adapters/osrm.js';
import { fixture, hang, json, networkError, serve, settle, text } from './support/fixtures.js';

/**
 * Provider contract tests.
 *
 * Every adapter is held to the same table of outcomes, served from fixtures
 * and never from the network: it succeeds; finds nothing; is refused; is rate
 * limited; times out; falls over; cannot be reached; answers with something
 * that is not JSON; answers with JSON of the wrong shape; and answers mostly
 * well with one bad row. Each of those is a *different* result, and none of
 * them may throw. The fixtures are hand-written from vendor documentation
 * (see fixtures/README.md), so this shows the adapters honour the documented
 * shape and fail safely on everything else, not that a vendor still answers in
 * that shape.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const place = (name: string, lat: number, lon: number, extra: Partial<Place> = {}): Place => ({
  id: `test:${name}`,
  name,
  displayName: name,
  coordinates: { lat, lon },
  countryCode: 'IN',
  countryName: 'India',
  timezone: 'Asia/Kolkata',
  airports: [],
  source: 'test',
  resolvedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});
const hyderabad = place('Hyderabad', 17.385, 78.4867, {
  airports: [{ iataCode: 'HYD', name: 'Rajiv Gandhi Intl', distanceKm: 24, coordinates: null }],
});
const bengaluru = place('Bengaluru', 12.9716, 77.5946, {
  airports: [{ iataCode: 'BLR', name: 'Kempegowda Intl', distanceKm: 35, coordinates: null }],
});

/** The outcome the traveller sees, as a class. */
const classOf = (r: ProviderResult<unknown>) => statusClass(r.status);
const failure = (r: ProviderResult<unknown>): ProviderFailure => {
  if (isOk(r)) throw new Error('expected a failure, got ok');
  return r;
};

// ---------------------------------------------------------------- Amadeus

const amadeus = () =>
  new AmadeusProvider({ clientId: 'placeholder-id', clientSecret: 'placeholder-secret', environment: 'test', minIntervalMs: 0 });

const withToken = (search: Parameters<typeof serve>[0]) => ({
  '/oauth2/token': json(fixture('amadeus/token.json')),
  ...search,
});

describe('Amadeus hotels', () => {
  const hotelRequest = {
    destination: bengaluru,
    checkIn: '2030-11-10',
    checkOut: '2030-11-14',
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
  };
  const routes = (overrides: Parameters<typeof serve>[0] = {}) =>
    withToken({
      '/by-geocode': json(fixture('amadeus/hotels-by-geocode.json')),
      '/hotel-offers': json(fixture('amadeus/hotel-offers.json')),
      ...overrides,
    });

  it('maps properties, rooms, rates and what the provider does and does not say', async () => {
    serve(routes());
    const res = await settle(amadeus().searchHotels(hotelRequest));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;

    const [grand, inn] = res.data;
    expect(grand!.name).toBe('Fixture Grand Bengaluru');
    expect(grand!.category).toBe(5);
    expect(grand!.rooms.map((r) => r.id)).toEqual(['GRAND-DELUXE-1', 'GRAND-SUITE-1']);
    const deluxe = grand!.rooms[0]!;
    expect(deluxe.totalPrice).toEqual({ amount: 4_248_000, currency: 'INR' });
    expect(deluxe.pricePerNight).toEqual({ amount: 1_062_000, currency: 'INR' });
    expect(deluxe.breakfastIncluded).toBe(true);
    expect(deluxe.refundable).toBe(true);
    // The provider states the number of guests a rate was priced for, not what the room sleeps.
    expect(deluxe.maxOccupancy).toBeNull();
    expect(grand!.rooms[1]!.refundable).toBe(false);
    expect(inn!.category).toBe(3);
    expect(inn!.rooms[0]!.breakfastIncluded).toBeNull();
    expect(res.warnings).toContain('Rates are indicative and may change before booking.');
  });

  it('says there is nothing when no property is listed, and when none has a room', async () => {
    serve(routes({ '/by-geocode': json({ data: [] }) }));
    expect((await settle(amadeus().searchHotels(hotelRequest))).status).toBe('no_availability');

    const body = fixture<{ data: Array<{ available: boolean }> }>('amadeus/hotel-offers.json');
    body.data.forEach((h) => {
      h.available = false;
    });
    serve(routes({ '/hotel-offers': json(body) }));
    expect((await settle(amadeus().searchHotels(hotelRequest))).status).toBe('no_availability');
  });

  it('drops a property with a price that is not a number and keeps the rest', async () => {
    const body = fixture<{ data: Array<{ offers: Array<{ price: { total: string } }> }> }>('amadeus/hotel-offers.json');
    body.data[0]!.offers[0]!.price.total = 'free';
    serve(routes({ '/hotel-offers': json(body) }));
    const res = await settle(amadeus().searchHotels(hotelRequest));
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.data).toHaveLength(1);
      expect(res.data[0]!.name).toBe('Fixture Budget Inn');
      expect(res.warnings.join(' ')).toMatch(/could not be read/);
    }
  });

  it('is unusable when the offers are not in the documented shape', async () => {
    serve(routes({ '/hotel-offers': json({ data: 'nothing' }) }));
    expect((await settle(amadeus().searchHotels(hotelRequest))).status).toBe('invalid_response');
  });

  it('fails one call without inventing rooms', async () => {
    serve(routes({ '/hotel-offers': json({}, 503) }));
    const res = await settle(amadeus().searchHotels(hotelRequest));
    expect(res.status).toBe('unavailable');
  });
});

// ------------------------------------------------------------------- OSRM

const OSRM = 'https://osrm.example.test';
const osrm = () => new OsrmRoutingProvider({ baseUrl: OSRM, minIntervalMs: 0 });
const routeRequest = { from: { lat: 17.385, lon: 78.4867 }, to: { lat: 17.2403, lon: 78.4294 }, profile: 'driving' as const };

describe('OSRM routing', () => {
  it('maps a route', async () => {
    serve({ '/route/v1/driving': json(fixture('osrm/route.json')) });
    const res = await settle(osrm().route(routeRequest));
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.data).toMatchObject({ distanceKm: 32.45, durationMinutes: 40 });
  });

  it('says when no road joins two points', async () => {
    serve({ '/route/v1/driving': json(fixture('osrm/no-route.json')) });
    const res = await settle(osrm().route(routeRequest));
    expect(res.status).toBe('unsupported_route');
    expect(classOf(res)).toBe('empty');
  });

  it.each([
    ['a server error', json({}, 500), 'unavailable', 'failed'],
    ['rate limiting', json({}, 429), 'rate_limited', 'rate_limited'],
    ['text instead of JSON', text('Service Unavailable'), 'invalid_response', 'unusable'],
    ['a route with no distance', json({ code: 'Ok', routes: [{ duration: 10 }] }), 'invalid_response', 'unusable'],
    ['routes that are not a list', json({ code: 'Ok', routes: 'x' }), 'invalid_response', 'unusable'],
    ['an unreachable server', networkError, 'unavailable', 'failed'],
  ])('reports %s distinctly', async (_name, reply, status, cls) => {
    serve({ '/route/v1/driving': reply });
    const res = await settle(osrm().route(routeRequest));
    expect(res.status).toBe(status);
    expect(classOf(res)).toBe(cls);
  });

  it('reports a hung server as a timeout', async () => {
    serve({ '/route/v1/driving': hang });
    const res = await settle(osrm().route(routeRequest), 5_000);
    expect(res.status).toBe('timeout');
  });
});

describe('OSRM transfers', () => {
  const tariff = { currency: 'INR', baseFare: 50, perKm: 18, perMinute: 2, nightMultiplier: 1.25 };
  const transfers = () => new OsrmTransferProvider(osrm(), { INR: tariff });
  const request = (over: Record<string, unknown> = {}) => ({
    from: { name: 'Home', coordinates: { lat: 17.385, lon: 78.4867 } },
    to: { name: 'Airport', coordinates: { lat: 17.2403, lon: 78.4294 } },
    // 23:30 in India, 18:00 in London: the same instant.
    at: '2030-11-10T18:00:00.000Z',
    timezone: 'Asia/Kolkata',
    party: { adults: 2, children: 0, infants: 0 },
    luggagePieces: 2,
    accessibleRequired: false,
    currency: 'INR',
    ...over,
  });
  const first = async (over: Record<string, unknown> = {}) => {
    serve({ '/route/v1/driving': json(fixture('osrm/route.json')) });
    const res = await settle(transfers().searchTransfers(request(over) as never));
    if (!isOk(res)) throw new Error(`expected ok, got ${res.status}`);
    return res.data[0]!;
  };

  it('prices from the configured tariff and says it is an estimate', async () => {
    const taxi = await first({ timezone: 'Europe/London' });
    // 50 + 18 * 32.45 + 2 * 40 minutes.
    expect(taxi.price!.amount).toBe(Math.round((50 + 18 * 32.45 + 2 * 40) * 100));
    expect(taxi.priceIsEstimate).toBe(true);
    expect(taxi.vehicles).toBe(1);
  });

  it('applies the night tariff by the clock where the ride happens, not the server clock', async () => {
    const day = await first({ timezone: 'Europe/London' });
    const night = await first({ timezone: 'Asia/Kolkata' });
    expect(night.price!.amount).toBe(Math.round(day.price!.amount * 1.25));
  });

  it('sends enough cars for the whole party', async () => {
    const one = await first();
    const five = await first({ party: { adults: 3, children: 2, infants: 0 } });
    expect(five.vehicles).toBe(2);
    expect(five.price!.amount).toBe(one.price!.amount * 2);
    expect(five.estimateBasis).toMatch(/2 cars/);
  });

  it('leaves the price out when there is no tariff, rather than inventing one', async () => {
    serve({ '/route/v1/driving': json(fixture('osrm/route.json')) });
    const res = await settle(new OsrmTransferProvider(osrm(), {}).searchTransfers(request() as never));
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.data[0]!.price).toBeNull();
  });
});

// -------------------------------------------------------------- Nominatim

const nominatim = () =>
  new NominatimProvider({ baseUrl: 'https://nominatim.example.test', userAgent: 'wayfare-test (nobody@example.invalid)', minIntervalMs: 0 });

describe('Nominatim', () => {
  it('resolves a place with its country and timezone', async () => {
    serve({ '/search': json(fixture('nominatim/search.json')) });
    const res = await settle(nominatim().resolvePlace('Hyderabad'));
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.data[0]).toMatchObject({ id: 'nominatim:297841623', countryCode: 'IN', timezone: 'Asia/Kolkata' });
    }
  });

  it('will not call without an identifying User-Agent', async () => {
    const { requests } = serve({});
    const bare = new NominatimProvider({ baseUrl: 'https://nominatim.example.test', userAgent: '', minIntervalMs: 0 });
    expect((await bare.resolvePlace('Hyderabad')).status).toBe('not_configured');
    expect(requests).toHaveLength(0);
  });

  it('sends its identifying User-Agent', async () => {
    const { requests } = serve({ '/search': json(fixture('nominatim/search.json')) });
    await settle(nominatim().resolvePlace('Hyderabad'));
    expect(requests[0]!.headers['user-agent']).toContain('wayfare-test');
  });

  it('distinguishes nothing found, a row without a country, and unusable rows', async () => {
    serve({ '/search': json([]) });
    expect((await settle(nominatim().resolvePlace('Zzzzzz'))).status).toBe('no_availability');

    const rows = fixture<Array<Record<string, unknown>>>('nominatim/search.json');
    const noCountry = { ...rows[0]!, place_id: 2, address: { city: 'Somewhere' } };
    serve({ '/search': json([rows[0], noCountry]) });
    const partial = await settle(nominatim().resolvePlace('x'));
    expect(isOk(partial)).toBe(true);
    if (isOk(partial)) {
      expect(partial.data).toHaveLength(1);
      expect(partial.warnings.join(' ')).toMatch(/discarded/);
    }

    serve({ '/search': json([{ unexpected: true }, 'text', 3]) });
    expect((await settle(nominatim().resolvePlace('x'))).status).toBe('invalid_response');
    serve({ '/search': json({ error: 'not a list' }) });
    expect((await settle(nominatim().resolvePlace('x'))).status).toBe('invalid_response');
  });

  it.each([
    ['rate limiting', json({}, 429), 'rate_limited'],
    ['a server error', json({}, 502), 'unavailable'],
    ['text instead of JSON', text('<html>'), 'invalid_response'],
  ])('reports %s distinctly', async (_name, reply, status) => {
    serve({ '/search': reply });
    expect((await settle(nominatim().resolvePlace('x'))).status).toBe(status);
  });

  it('treats the reverse-lookup "nothing here" answer as empty', async () => {
    serve({ '/reverse': json({ error: 'Unable to geocode' }) });
    expect((await settle(nominatim().reverse({ lat: 0, lon: 0 }))).status).toBe('no_availability');
  });
});

// ----------------------------------------------------------------- Google

const google = { apiKey: 'placeholder-key', minIntervalMs: 0 };
const placesRequest = {
  destination: bengaluru,
  near: { lat: 12.9716, lon: 77.5946 },
  radiusKm: 10,
  categories: [],
  accessibilityNeeds: [],
  currency: 'INR',
  limit: 10,
};

describe('Google Places', () => {
  it('maps places, opening hours where published, and flags where they are not', async () => {
    serve({ 'searchNearby': json(fixture('google/places.json')) });
    const res = await settle(new GooglePlacesProvider(google).searchActivities(placesRequest));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    const [fort, park] = res.data;
    expect(fort!.name).toBe('Fixture Fort');
    expect(fort!.openingHours).toHaveLength(6);
    expect(fort!.openingHours!.find((h) => h.weekday === 6)).toBeUndefined();
    expect(park!.openingHours).toBeNull();
    expect(res.warnings.join(' ')).toMatch(/Opening hours are not published for Fixture Park/);
  });

  it('keeps the readable places and says how many were left out', async () => {
    const body = fixture<{ places: unknown[] }>('google/places.json');
    body.places.push({ id: 'broken', location: { latitude: 999, longitude: 0 } });
    serve({ 'searchNearby': json(body) });
    const res = await settle(new GooglePlacesProvider(google).searchActivities(placesRequest));
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.data).toHaveLength(2);
      expect(res.warnings.join(' ')).toMatch(/1 place\(s\)/);
    }
  });

  it.each([
    ['nothing nearby', json({}), 'no_availability'],
    ['every place unreadable', json({ places: [{ nope: 1 }] }), 'invalid_response'],
    ['a rejected key', json({ error: {} }, 403), 'not_configured'],
    ['a server error', json({}, 500), 'unavailable'],
    ['rate limiting', json({}, 429), 'rate_limited'],
  ])('reports %s distinctly', async (_name, reply, status) => {
    serve({ 'searchNearby': reply });
    expect((await settle(new GooglePlacesProvider(google).searchActivities(placesRequest))).status).toBe(status);
  });

  it('is not configured without a key, and makes no request', async () => {
    const { requests } = serve({});
    const res = await new GooglePlacesProvider({ apiKey: '', minIntervalMs: 0 }).searchActivities(placesRequest);
    expect(res.status).toBe('not_configured');
    expect(requests).toHaveLength(0);
  });
});

describe('Google Routes', () => {
  it('maps a route', async () => {
    serve({ computeRoutes: json(fixture('google/routes.json')) });
    const res = await settle(new GoogleRoutesProvider(google).route(routeRequest));
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.data).toMatchObject({ distanceKm: 9.8, durationMinutes: 27 });
  });

  it.each([
    ['no route', json({ routes: [] }), 'unsupported_route'],
    ['a duration that is not seconds', json({ routes: [{ distanceMeters: 100, duration: 'soon' }] }), 'invalid_response'],
  ])('reports %s distinctly', async (_name, reply, status) => {
    serve({ computeRoutes: reply });
    expect((await settle(new GoogleRoutesProvider(google).route(routeRequest))).status).toBe(status);
  });
});

// --------------------------------------------------- surface (rail / bus)

const railConfig = {
  baseUrl: 'https://rail.example.test',
  apiKey: 'placeholder-key',
  coverage: ['IN'] as string[],
  label: 'Test Rail',
  requiredEnv: ['RAIL_PROVIDER_URL'],
  attribution: null,
  minIntervalMs: 0,
  timeoutMs: 5_000,
};
const surfaceRequest = {
  origin: hyderabad,
  destination: bengaluru,
  date: '2030-11-10',
  party: { adults: 2, children: 0, infants: 0 },
  currency: 'INR',
  classCode: null,
  limit: 20,
};

describe('surface transport contract (rail)', () => {
  it('maps the documented response', async () => {
    serve({ '/search/trains': json(fixture('surface/rail.json')) });
    const res = await settle(new GenericRailProvider(railConfig).searchTrains(surfaceRequest));
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.data[0]).toMatchObject({ mode: 'train', overnight: true, selectedFareCode: 'SL', id: 'rail:2030-11-10:12785' });
    }
  });

  it('refuses a timestamp with no UTC offset, as the contract says it does', async () => {
    const body = fixture<{ services: Array<{ legs: Array<{ departureAt: string }> }> }>('surface/rail.json');
    body.services[0]!.legs[0]!.departureAt = '2030-11-10T19:05:00';
    serve({ '/search/trains': json(body) });
    expect((await settle(new GenericRailProvider(railConfig).searchTrains(surfaceRequest))).status).toBe('invalid_response');
  });

  it('refuses a service that arrives before it leaves', async () => {
    const body = fixture<{ services: Array<{ legs: Array<{ arrivalAt: string }> }> }>('surface/rail.json');
    body.services[0]!.legs[0]!.arrivalAt = '2030-11-10T18:00:00+05:30';
    serve({ '/search/trains': json(body) });
    expect((await settle(new GenericRailProvider(railConfig).searchTrains(surfaceRequest))).status).toBe('invalid_response');
  });

  it('keeps the good services when one is bad', async () => {
    const body = fixture<{ services: Array<Record<string, unknown>> }>('surface/rail.json');
    body.services.push({ id: 'bad', legs: [] });
    serve({ '/search/trains': json(body) });
    const res = await settle(new GenericRailProvider(railConfig).searchTrains(surfaceRequest));
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.data).toHaveLength(1);
      expect(res.warnings.join(' ')).toMatch(/1 service\(s\)/);
    }
  });

  it('says there are no services, distinctly from failing', async () => {
    serve({ '/search/trains': json({ services: [] }) });
    const res = await settle(new GenericRailProvider(railConfig).searchTrains(surfaceRequest));
    expect(res.status).toBe('no_availability');
  });
});
