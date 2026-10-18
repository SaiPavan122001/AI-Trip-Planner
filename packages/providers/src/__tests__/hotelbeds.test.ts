import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isOk, ok, statusClass, type Place, type ProviderFailure, type ProviderResult } from '@trip/shared';
import { HotelbedsActivitiesProvider } from '../adapters/hotelbeds-activities.js';
import { HOTELBEDS_HOSTS, HotelbedsClient, hotelbedsSignature } from '../adapters/hotelbeds-client.js';
import { HotelbedsHotelsProvider, stars } from '../adapters/hotelbeds-hotels.js';
import { HotelbedsTransfersProvider } from '../adapters/hotelbeds-transfers.js';
import { loadProvidersEnv } from '../config.js';
import { ProviderRegistry } from '../registry.js';
import type { ActivitySearchRequest, HotelSearchRequest, QuotedTransferRequest } from '../types.js';
import { fixture, hang, json, networkError, serve, settle, text } from './support/fixtures.js';

/**
 * Hotelbeds Hotel, Activities and Transfers, served from synthetic fixtures.
 * Nothing here uses a real key or the network, and nothing books anything.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const KEY = 'hbkey_FIXTURE_NOT_REAL';
const SECRET = 'hbsecret_FIXTURE_NOT_REAL';

const client = (env: 'test' | 'live' = 'test', now = () => 1_700_000_000_000) =>
  new HotelbedsClient({ apiKey: KEY, secret: SECRET }, env, 0, now);

const place: Place = {
  id: 'test:Bengaluru',
  name: 'Bengaluru',
  displayName: 'Bengaluru',
  coordinates: { lat: 12.9716, lon: 77.5946 },
  countryCode: 'IN',
  countryName: 'India',
  timezone: 'Asia/Kolkata',
  airports: [],
  source: 'test',
  resolvedAt: '2026-01-01T00:00:00.000Z',
};

const failure = (r: ProviderResult<unknown>): ProviderFailure => {
  if (isOk(r)) throw new Error('expected a failure, got ok');
  return r;
};
const noSecrets = (value: unknown) => {
  const s = JSON.stringify(value);
  expect(s).not.toContain(KEY);
  expect(s).not.toContain(SECRET);
};

// -------------------------------------------------------------- the client

describe('Hotelbeds signing', () => {
  it('signs the key, secret and Unix seconds, in that order, as hex SHA-256', () => {
    const expected = createHash('sha256').update(`${KEY}${SECRET}1700000000`).digest('hex');
    expect(hotelbedsSignature({ apiKey: KEY, secret: SECRET }, 1_700_000_000_999)).toBe(expected);
  });

  it('sends Api-key, a fresh X-Signature and JSON accept, to the test or live host', async () => {
    let t = 1_700_000_000_000;
    const c = client('test', () => t);
    const { requests } = serve({ '/hotel-api/1.0/status': json({ status: 'OK' }) });
    await settle(c.get('/hotel-api/1.0/status'));
    t += 5_000;
    await settle(c.get('/hotel-api/1.0/status'));
    expect(requests[0]!.url.origin).toBe(HOTELBEDS_HOSTS.test);
    expect(requests[0]!.headers['api-key']).toBe(KEY);
    expect(requests[0]!.headers['accept']).toBe('application/json');
    expect(requests[0]!.headers['x-signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(requests[1]!.headers['x-signature']).not.toBe(requests[0]!.headers['x-signature']);
    expect(HOTELBEDS_HOSTS.live).toBe('https://api.hotelbeds.com');
    expect(HOTELBEDS_HOSTS.test).toBe('https://api.test.hotelbeds.com');
  });
});

// ------------------------------------------------------------------ hotels

const hotelRequest: HotelSearchRequest = {
  destination: place,
  checkIn: '2030-11-10',
  checkOut: '2030-11-13',
  rooms: 1,
  party: { adults: 2, children: 0, infants: 0 },
  minCategory: null,
  maxPricePerNight: null,
  currency: 'INR',
  amenities: [],
  freeCancellationOnly: false,
  near: null,
  radiusKm: 10,
  limit: 20,
};
const hotels = () => new HotelbedsHotelsProvider(client());
const hotelRoutes = (over: Parameters<typeof serve>[0] = {}) =>
  serve({
    '/hotel-api/1.0/hotels': json(fixture('hotelbeds/availability.json')),
    '/hotel-content-api/1.0/hotels': json(fixture('hotelbeds/content.json')),
    ...over,
  });

describe('Hotelbeds hotels: request and mapping', () => {
  it('posts a stay, occupancy and position to the availability endpoint', async () => {
    const { requests } = hotelRoutes();
    await settle(hotels().searchHotels({ ...hotelRequest, rooms: 2, party: { adults: 3, children: 1, infants: 0 } }));
    const search = requests.find((r) => r.url.pathname === '/hotel-api/1.0/hotels')!;
    expect(search.method).toBe('POST');
    expect(search.headers['api-key']).toBe(KEY);
    expect(search.body).toEqual({
      stay: { checkIn: '2030-11-10', checkOut: '2030-11-13' },
      occupancies: [{ rooms: 2, adults: 2, children: 0 }],
      geolocation: { latitude: 12.9716, longitude: 77.5946, radius: 10, unit: 'km' },
    });
  });

  it('maps rooms, rates, boards, refundability and taxes, and only what the provider states', async () => {
    hotelRoutes();
    const res = await settle(hotels().searchHotels(hotelRequest));
    if (!isOk(res)) throw new Error('expected ok');
    expect(res.data.map((h) => h.name)).toEqual(['Fixture Budget Inn', 'Fixture Grand Hotel']);

    const [inn, grand] = res.data;
    expect(inn!.category).toBe(2);
    expect(inn!.coordinates).toEqual({ lat: 12.9716, lon: 77.5946 });
    expect(inn!.description).toBe('A plain, clean fixture inn near the fixture market.');
    expect(inn!.address).toBe('1 Fixture Road, Bengaluru');
    expect(inn!.amenities).toEqual([]);
    expect(inn!.rooms[0]).toMatchObject({
      roomType: 'Double Standard',
      boardType: 'ROOM ONLY',
      breakfastIncluded: false,
      refundable: false,
      taxesIncluded: true,
      payAtProperty: null,
      totalPrice: { amount: 900_000, currency: 'INR' },
      pricePerNight: { amount: 300_000, currency: 'INR' },
    });

    // A rate for two rooms is brought down to one room; the selling price is used when it is sent;
    // taxes the provider says are paid at the property are kept apart from the room price.
    expect(grand!.category).toBe(5);
    expect(grand!.rooms[0]).toMatchObject({
      breakfastIncluded: true,
      refundable: true,
      cancellationDeadline: '2030-11-05T23:59:00+05:30',
      taxesIncluded: false,
      totalPrice: { amount: 3_000_000, currency: 'INR' },
      payAtProperty: { amount: 75_000, currency: 'INR' },
    });
    expect(grand!.rooms[0]!.cancellationPolicy).toContain('20000.00 INR');
  });

  it('leaves out a property with no position, and says a rate needs a re-check and that this is a test account', async () => {
    hotelRoutes();
    const res = await settle(hotels().searchHotels(hotelRequest));
    if (!isOk(res)) throw new Error('expected ok');
    expect(res.data.some((h) => h.name.includes('Unlocated'))).toBe(false);
    const warnings = res.warnings.join(' ');
    expect(warnings).toMatch(/1 rate\(s\).*re-check/);
    expect(warnings).toMatch(/test account/);
    expect(res.provenance.providerLabel).toBe('Hotelbeds Hotels (test account)');
  });

  it('counts children as adults and says so', async () => {
    hotelRoutes();
    const res = await settle(hotels().searchHotels({ ...hotelRequest, party: { adults: 2, children: 1, infants: 0 } }));
    if (!isOk(res)) throw new Error('expected ok');
    expect(res.warnings.join(' ')).toMatch(/Children are counted as adults/);
  });

  it('applies the category and price limits the search cannot', async () => {
    hotelRoutes();
    const high = await settle(hotels().searchHotels({ ...hotelRequest, minCategory: 4 }));
    if (!isOk(high)) throw new Error('expected ok');
    expect(high.data.map((h) => h.name)).toEqual(['Fixture Grand Hotel']);
    hotelRoutes();
    const cheap = await settle(hotels().searchHotels({ ...hotelRequest, maxPricePerNight: 5000 }));
    if (!isOk(cheap)) throw new Error('expected ok');
    expect(cheap.data.map((h) => h.name)).toEqual(['Fixture Budget Inn']);
  });

  it('keeps a spread from cheapest to dearest when it must cut the list', async () => {
    hotelRoutes();
    const res = await settle(hotels().searchHotels({ ...hotelRequest, limit: 2 }));
    if (!isOk(res)) throw new Error('expected ok');
    expect(res.data.map((h) => h.name)).toEqual(['Fixture Budget Inn', 'Fixture Grand Hotel']);
  });

  it('still returns rooms and prices when the content service fails', async () => {
    hotelRoutes({ '/hotel-content-api/1.0/hotels': json({ errors: [] }, 500) });
    const res = await settle(hotels().searchHotels(hotelRequest));
    if (!isOk(res)) throw new Error('expected ok');
    expect(res.data[0]!.description).toBeNull();
    expect(res.warnings.join(' ')).toMatch(/descriptions could not be loaded/);
    expect(res.data[0]!.rooms[0]!.totalPrice.amount).toBe(900_000);
  });

  it('keeps a price in another currency as it is, so the planner can set it aside', async () => {
    const body = fixture<{ hotels: { hotels: Array<Record<string, unknown>> } }>('hotelbeds/availability.json');
    for (const h of body.hotels.hotels) h['currency'] = 'EUR';
    hotelRoutes({ '/hotel-api/1.0/hotels': json(body) });
    const res = await settle(hotels().searchHotels(hotelRequest));
    if (!isOk(res)) throw new Error('expected ok');
    expect(res.data[0]!.rooms[0]!.totalPrice.currency).toBe('EUR');
  });
});

describe('Hotelbeds hotels: empty, malformed and failing answers', () => {
  it('reports no hotels as empty', async () => {
    hotelRoutes({ '/hotel-api/1.0/hotels': json({ hotels: { hotels: [] } }) });
    const res = await settle(hotels().searchHotels(hotelRequest));
    expect(res.status).toBe('no_availability');
    expect(statusClass(res.status)).toBe('empty');
  });

  it('is unusable when no property has the documented shape, or the body is not JSON', async () => {
    hotelRoutes({ '/hotel-api/1.0/hotels': json({ hotels: { hotels: [{ nope: true }] } }) });
    expect((await settle(hotels().searchHotels(hotelRequest))).status).toBe('invalid_response');
    hotelRoutes({ '/hotel-api/1.0/hotels': text('<html>oops</html>') });
    expect((await settle(hotels().searchHotels(hotelRequest))).status).toBe('invalid_response');
  });

  it('keeps good rates and counts the bad one', async () => {
    const body = fixture<{ hotels: { hotels: Array<{ rooms: Array<{ rates: Array<Record<string, unknown>> }> }> } }>(
      'hotelbeds/availability.json',
    );
    body.hotels.hotels[0]!.rooms[0]!.rates.push({ rateKey: 'bad', net: 'not-a-number' });
    hotelRoutes({ '/hotel-api/1.0/hotels': json(body) });
    const res = await settle(hotels().searchHotels(hotelRequest));
    if (!isOk(res)) throw new Error('expected ok');
    expect(res.warnings.join(' ')).toMatch(/1 property or rate listing\(s\)/);
  });

  it.each([
    [401, 'not_configured'],
    [403, 'not_configured'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
  ])('reports HTTP %i as %s', async (status, expected) => {
    hotelRoutes({ '/hotel-api/1.0/hotels': json({ error: 'x' }, status as number, { 'retry-after': '4' }) });
    const res = failure(await settle(hotels().searchHotels(hotelRequest)));
    expect(res.status).toBe(expected);
    noSecrets(res);
  });

  it('reports a call that never answers as a timeout, and a refused connection as unreachable', async () => {
    hotelRoutes({ '/hotel-api/1.0/hotels': hang });
    expect((await settle(hotels().searchHotels(hotelRequest), 5_000)).status).toBe('timeout');
    hotelRoutes({ '/hotel-api/1.0/hotels': networkError });
    expect((await settle(hotels().searchHotels(hotelRequest))).status).toBe('unavailable');
  });

  it('stops when the caller cancels', async () => {
    hotelRoutes({ '/hotel-api/1.0/hotels': hang });
    const controller = new AbortController();
    const pending = hotels().searchHotels({ ...hotelRequest, signal: controller.signal });
    controller.abort();
    const res = failure(await settle(pending));
    expect(res.local).toBe(true);
  });

  it('refuses a room too crowded to search, without a request', async () => {
    const { requests } = hotelRoutes();
    const res = failure(await hotels().searchHotels({ ...hotelRequest, party: { adults: 12, children: 0, infants: 0 } }));
    expect(res.status).toBe('invalid_request');
    expect(requests).toHaveLength(0);
  });

  it('says so with no credentials and makes no request', async () => {
    const { requests } = hotelRoutes();
    const bare = new HotelbedsHotelsProvider(new HotelbedsClient({ apiKey: '', secret: '' }, 'test', 0));
    const res = failure(await bare.searchHotels(hotelRequest));
    expect(res.status).toBe('not_configured');
    expect(res.message).toMatch(/HOTELBEDS_API_KEY/);
    expect(requests).toHaveLength(0);
  });

  it('never puts the key, the secret or a signature in what it returns', async () => {
    hotelRoutes();
    const okRes = await settle(hotels().searchHotels(hotelRequest));
    noSecrets(okRes);
    expect(JSON.stringify(okRes)).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe('Hotelbeds hotels: rate re-check', () => {
  it('re-checks a rate by its key and prices it afresh', async () => {
    const { requests } = hotelRoutes({ '/hotel-api/1.0/checkrates': json(fixture('hotelbeds/checkrate.json')) });
    const search = await settle(hotels().searchHotels(hotelRequest));
    if (!isOk(search)) throw new Error('expected ok');
    const token = search.data[1]!.rooms[0]!.revalidationToken!;

    const res = await settle(hotels().revalidateHotel(token));
    if (!isOk(res)) throw new Error('expected ok');
    const check = requests.find((r) => r.url.pathname === '/hotel-api/1.0/checkrates')!;
    expect(check.method).toBe('POST');
    expect(check.body).toEqual({ rooms: [{ rateKey: 'FIXTURE|RATEKEY|2002|B' }] });
    expect(res.data.rooms[0]!.totalPrice).toEqual({ amount: 3_100_000, currency: 'INR' });
  });

  it('refuses a token that is not one it issued, and makes no request', async () => {
    const { requests } = hotelRoutes();
    for (const bad of ['', 'plain-key', '{"v":2}', '{"v":1,"rateKey":"x"}']) {
      expect(failure(await hotels().revalidateHotel(bad)).status).toBe('invalid_request');
    }
    expect(requests).toHaveLength(0);
  });
});

describe('Hotelbeds categories', () => {
  it('reads stars only where the code states them', () => {
    expect(stars('4EST')).toBe(4);
    expect(stars('5LUX')).toBe(5);
    expect(stars('H3_5')).toBe(3.5);
    expect(stars('HS')).toBeNull();
    expect(stars('APTH')).toBeNull();
    expect(stars(undefined)).toBeNull();
  });
});

// -------------------------------------------------------------- activities

const activityRequest: ActivitySearchRequest = {
  destination: place,
  near: place.coordinates,
  radiusKm: 12,
  categories: [],
  accessibilityNeeds: [],
  currency: 'INR',
  limit: 20,
  window: { from: '2030-11-10', to: '2030-11-13', party: { adults: 2, children: 1, infants: 0 } },
};
const activities = () => new HotelbedsActivitiesProvider(client());
const activityRoutes = (reply = json(fixture('hotelbeds/activities.json'))) =>
  serve({ '/activity-api/3.0/activities/availability': reply });

describe('Hotelbeds activities', () => {
  it('posts dates, travellers and a position filter', async () => {
    const { requests } = activityRoutes();
    await settle(activities().searchActivities(activityRequest));
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.body).toMatchObject({
      filters: [{ searchFilterItems: [{ type: 'gps', latitude: 12.9716, longitude: 77.5946 }] }],
      from: '2030-11-10',
      to: '2030-11-13',
      paxes: [{ age: 30 }, { age: 30 }, { age: 8 }],
    });
  });

  it('maps bookable activities with the provider price, and claims nothing it was not told', async () => {
    activityRoutes();
    const res = await settle(activities().searchActivities(activityRequest));
    if (!isOk(res)) throw new Error('expected ok');
    // The activity with no currency cannot be priced or trusted and is left out.
    expect(res.data.map((a) => a.id)).toEqual(['hotelbeds-activity:ACT-100', 'hotelbeds-activity:ACT-200']);
    const [walk, tour] = res.data;
    expect(walk!.price).toEqual({ amount: 300_000, currency: 'INR' });
    expect(walk!.typicalDurationMinutes).toBe(150);
    expect(walk!.bookingRequired).toBe(true);
    // Not confirmed for a particular day, so it is not presented as a final quote.
    expect(walk!.priceIsEstimate).toBe(true);
    expect(walk!.openingHours).toBeNull();
    expect(walk!.rating).toBeNull();
    // 2 adults at 800 and 1 child at 400.
    expect(tour!.price).toEqual({ amount: 200_000, currency: 'INR' });
    // A bare duration number has no stated unit, so it is not guessed.
    expect(tour!.typicalDurationMinutes).toBeNull();
    expect(res.warnings.join(' ')).toMatch(/not yet confirmed for a particular day/);
    expect(res.warnings.join(' ')).toMatch(/child ages are not collected|Child ages are not collected/);
  });

  it('needs dates and a party, and says so without a request', async () => {
    const { requests } = activityRoutes();
    const { window: _w, ...bare } = activityRequest;
    const res = failure(await activities().searchActivities(bare));
    expect(res.status).toBe('invalid_request');
    expect(requests).toHaveLength(0);
  });

  it('handles empty, malformed, refused and limited answers separately', async () => {
    activityRoutes(json({ activities: [] }));
    expect((await settle(activities().searchActivities(activityRequest))).status).toBe('no_availability');
    activityRoutes(json({ activities: [{ nope: 1 }] }));
    expect((await settle(activities().searchActivities(activityRequest))).status).toBe('invalid_response');
    activityRoutes(json({ error: 'x' }, 403));
    expect((await settle(activities().searchActivities(activityRequest))).status).toBe('not_configured');
    activityRoutes(json({ error: 'x' }, 429, { 'retry-after': '9' }));
    const limited = failure(await settle(activities().searchActivities(activityRequest)));
    expect(limited.status).toBe('rate_limited');
    noSecrets(limited);
    activityRoutes(hang);
    expect((await settle(activities().searchActivities(activityRequest), 5_000)).status).toBe('timeout');
  });

  it('says so with no credentials', async () => {
    const bare = new HotelbedsActivitiesProvider(new HotelbedsClient({ apiKey: '', secret: '' }, 'test', 0));
    expect(failure(await bare.searchActivities(activityRequest)).message).toMatch(/Hotelbeds Activities is not configured/);
  });
});

// --------------------------------------------------------------- transfers

const transferRequest: QuotedTransferRequest = {
  from: { type: 'IATA', code: 'BLR' },
  to: { type: 'ATLAS', code: '1001' },
  at: '2030-11-10T05:00:00Z',
  timezone: 'Asia/Kolkata',
  party: { adults: 2, children: 0, infants: 0 },
  currency: 'INR',
};
const transfers = () => new HotelbedsTransfersProvider(client());
const transferRoutes = (reply = json(fixture('hotelbeds/transfers.json'))) =>
  serve({ '/transfer-api/1.0/availability/': reply });

describe('Hotelbeds transfers', () => {
  it('asks for a one-way transfer by airport and hotel code, at the local pick-up time', async () => {
    const { requests } = transferRoutes();
    await settle(transfers().quoteTransfers(transferRequest));
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.url.pathname).toBe(
      '/transfer-api/1.0/availability/en/from/IATA/BLR/to/ATLAS/1001/2030-11-10T10:30:00/2/0/0',
    );
    expect(requests[0]!.headers['api-key']).toBe(KEY);
  });

  it('maps services with their price, vehicle, capacity, luggage and cancellation terms', async () => {
    transferRoutes();
    const res = await settle(transfers().quoteTransfers(transferRequest));
    if (!isOk(res)) throw new Error('expected ok');
    expect(res.data).toHaveLength(3);
    const car = res.data[0]!;
    expect(car).toMatchObject({
      id: 'hotelbeds-transfer:11',
      kind: 'private',
      vehicle: 'Standard Car',
      maxPassengers: 3,
      luggage: 'Luggage: 2 suitcases',
      token: 'FIXTURE|TRANSFER|11',
      price: { amount: 180_050, currency: 'INR' },
    });
    expect(car.cancellationPolicy).toContain('From 2030-11-09T10:30:00');
    expect(res.data[2]!.kind).toBe('shared');
    expect(res.data[1]!.luggage).toBeNull();
  });

  it('refuses a code that could change the path, and a search with no adult, without a request', async () => {
    const { requests } = transferRoutes();
    const evil = failure(await transfers().quoteTransfers({ ...transferRequest, to: { type: 'ATLAS', code: '1/../x' } }));
    expect(evil.status).toBe('invalid_request');
    const none = failure(await transfers().quoteTransfers({ ...transferRequest, party: { adults: 0, children: 1, infants: 0 } }));
    expect(none.status).toBe('invalid_request');
    expect(requests).toHaveLength(0);
  });

  it('handles empty, malformed and failing answers separately', async () => {
    transferRoutes(json({ services: [] }));
    expect((await settle(transfers().quoteTransfers(transferRequest))).status).toBe('no_availability');
    transferRoutes(json({ services: [{ id: 1 }] }));
    expect((await settle(transfers().quoteTransfers(transferRequest))).status).toBe('invalid_response');
    transferRoutes(json({ error: 'x' }, 401));
    expect((await settle(transfers().quoteTransfers(transferRequest))).status).toBe('not_configured');
    transferRoutes(json({ error: 'x' }, 500));
    expect((await settle(transfers().quoteTransfers(transferRequest))).status).toBe('unavailable');
    transferRoutes(networkError);
    expect((await settle(transfers().quoteTransfers(transferRequest))).status).toBe('unavailable');
  });

  it('says so with no credentials', async () => {
    const bare = new HotelbedsTransfersProvider(new HotelbedsClient({ apiKey: '', secret: '' }, 'test', 0));
    expect(failure(await bare.quoteTransfers(transferRequest)).message).toMatch(/Hotelbeds Transfers is not configured/);
  });

  it('keeps secrets out of what it returns', async () => {
    transferRoutes();
    noSecrets(await settle(transfers().quoteTransfers(transferRequest)));
  });
});

// ------------------------------------------------- configuration, registry

describe('Hotelbeds configuration: three capabilities, reported separately', () => {
  const pair = { HOTELBEDS_API_KEY: 'k', HOTELBEDS_SECRET: 's' };

  it('is off without credentials, and the application still starts', () => {
    const hb = loadProvidersEnv({}).hotelbeds;
    expect(hb).toMatchObject({ environment: 'test', hotels: null, activities: null, transfers: null });
  });

  it('shares one pair across the three, defaulting to the test account', () => {
    const hb = loadProvidersEnv(pair).hotelbeds;
    expect(hb.environment).toBe('test');
    expect(hb.hotels).toEqual({ apiKey: 'k', secret: 's' });
    expect(hb.activities).toEqual({ apiKey: 'k', secret: 's' });
    expect(hb.transfers).toEqual({ apiKey: 'k', secret: 's' });
  });

  it('lets one API have its own pair, or be switched off, without touching the others', () => {
    const hb = loadProvidersEnv({
      ...pair,
      HOTELBEDS_HOTELS_API_KEY: 'hk',
      HOTELBEDS_HOTELS_SECRET: 'hs',
      HOTELBEDS_ACTIVITIES_ENABLED: 'false',
    }).hotelbeds;
    expect(hb.hotels).toEqual({ apiKey: 'hk', secret: 'hs' });
    expect(hb.activities).toBeNull();
    expect(hb.transfers).toEqual({ apiKey: 'k', secret: 's' });
  });

  it('can run on credentials for one API alone', () => {
    const hb = loadProvidersEnv({ HOTELBEDS_TRANSFERS_API_KEY: 'tk', HOTELBEDS_TRANSFERS_SECRET: 'ts' }).hotelbeds;
    expect(hb.transfers).toEqual({ apiKey: 'tk', secret: 'ts' });
    expect(hb.hotels).toBeNull();
    expect(hb.activities).toBeNull();
  });

  it('refuses half a pair or an unknown mode, naming the setting and not a value', () => {
    let message = '';
    try {
      loadProvidersEnv({ HOTELBEDS_API_KEY: 'only-the-key-secret-value' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/HOTELBEDS_API_KEY and HOTELBEDS_SECRET must be set together/);
    expect(message).not.toContain('only-the-key-secret-value');
    expect(() => loadProvidersEnv({ HOTELBEDS_ENV: 'sandbox' })).toThrow(/"test" or "live"/);
    expect(loadProvidersEnv({ ...pair, HOTELBEDS_ENV: 'live' }).hotelbeds.environment).toBe('live');
  });

  it('registers each capability on its own and lists the others as disabled, so one never stands in for another', () => {
    const registry = new ProviderRegistry(
      loadProvidersEnv({ ...pair, HOTELBEDS_ACTIVITIES_ENABLED: 'false' }),
    );
    expect(registry.hotels.map((p) => p.descriptor.id)).toEqual(['hotelbeds-hotels']);
    expect(registry.quotedTransfers.map((p) => p.descriptor.id)).toEqual(['hotelbeds-transfers']);
    expect(registry.activities).toHaveLength(0);
    const off = registry.disabled.find((d) => d.id === 'hotelbeds-activities');
    expect(off?.capabilities.activities).toMatch(/not connected/);
    expect(registry.disabled.some((d) => d.id === 'hotelbeds-hotels')).toBe(false);
    expect(registry.missingCapabilityNote('activities', ['hotelbeds-activities']).message).toMatch(/Hotelbeds Activities is not connected/);
  });

  it('keeps Hotelbeds hotels beside Amadeus hotels, and flights on Duffel alone', () => {
    const registry = new ProviderRegistry(
      loadProvidersEnv({ ...pair, AMADEUS_CLIENT_ID: 'i', AMADEUS_CLIENT_SECRET: 's', DUFFEL_ACCESS_TOKEN: 'duffel_test_x' }),
    );
    expect(registry.hotels.map((p) => p.descriptor.id).sort()).toEqual(['amadeus', 'hotelbeds-hotels']);
    expect(registry.flights.map((p) => p.descriptor.id)).toEqual(['duffel']);
  });

  it('reports health through each provider, not a shared answer', async () => {
    const registry = new ProviderRegistry(loadProvidersEnv({ ...pair, HOTELBEDS_HOTELS_ENABLED: 'false' }));
    serve({});
    const ids = registry.all().map((p) => p.descriptor.id);
    expect(ids).toContain('hotelbeds-activities');
    expect(ids).toContain('hotelbeds-transfers');
    expect(ids).not.toContain('hotelbeds-hotels');
    expect(ok(1, { provider: 'x', providerLabel: 'x', retrievedAt: '', validUntil: null, searchId: null, attribution: null }).status).toBe('ok');
  });
});
