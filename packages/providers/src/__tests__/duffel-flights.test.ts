import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isOk, statusClass, type Place, type ProviderFailure, type ProviderResult } from '@trip/shared';
import { DuffelProvider, DUFFEL_VERSION } from '../adapters/duffel.js';
import { loadProvidersEnv } from '../config.js';
import { ProviderRegistry } from '../registry.js';
import { fixture, hang, json, networkError, serve, settle, text } from './support/fixtures.js';

/**
 * Duffel flight search, served from synthetic fixtures. The fixtures follow the
 * documented shape (https://duffel.com/docs/api); they are not recordings, and
 * no test here talks to the network or needs a real token. Nothing creates an
 * order or a payment: the adapter has no such call.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Looks like a Duffel token so the secret checks below mean something.
const TOKEN = 'duffel_test_FIXTURE_TOKEN_NOT_REAL_0123456789';

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

const duffel = (over: Partial<ConstructorParameters<typeof DuffelProvider>[0]> = {}) =>
  new DuffelProvider({ accessToken: TOKEN, environment: 'test', minIntervalMs: 0, ...over });

const failure = (r: ProviderResult<unknown>): ProviderFailure => {
  if (isOk(r)) throw new Error('expected a failure, got ok');
  return r;
};
const classOf = (r: ProviderResult<unknown>) => statusClass(r.status);

const flightRequest = {
  origin: hyderabad,
  destination: bengaluru,
  departureDate: '2030-11-10',
  returnDate: null,
  party: { adults: 2, children: 0, infants: 0 },
  cabinClass: null,
  maxStops: null,
  preferredCarriers: [] as string[],
  excludedCarriers: [] as string[],
  currency: 'INR',
  maxPrice: null,
  limit: 20,
};

const search = (reply = json(fixture('duffel/offer-request.json'), 201)) => serve({ '/air/offer_requests': reply });

describe('Duffel request construction', () => {
  it('authenticates with a bearer token, names the API version, and posts to the one Duffel host', async () => {
    const { requests } = search();
    await settle(duffel().searchFlights(flightRequest));
    const req = requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url.origin).toBe('https://api.duffel.com');
    expect(req.url.pathname).toBe('/air/offer_requests');
    expect(req.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(req.headers['duffel-version']).toBe(DUFFEL_VERSION);
    expect(req.headers['accept']).toBe('application/json');
    expect(req.url.searchParams.get('return_offers')).toBe('true');
  });

  it('sends the route, the date and every traveller', async () => {
    const { requests } = search();
    await settle(
      duffel().searchFlights({ ...flightRequest, party: { adults: 2, children: 1, infants: 1 }, cabinClass: 'business', maxStops: 0 }),
    );
    expect(requests[0]!.body).toEqual({
      data: {
        slices: [{ origin: 'HYD', destination: 'BLR', departure_date: '2030-11-10' }],
        passengers: [{ type: 'adult' }, { type: 'adult' }, { type: 'child' }, { type: 'infant_without_seat' }],
        cabin_class: 'business',
        max_connections: 0,
      },
    });
  });

  it('adds the return slice for a round trip, and leaves cabin and connections out when unset', async () => {
    const { requests } = search();
    await settle(duffel().searchFlights({ ...flightRequest, returnDate: '2030-11-14' }));
    const data = (requests[0]!.body as { data: Record<string, unknown> }).data;
    expect(data['slices']).toEqual([
      { origin: 'HYD', destination: 'BLR', departure_date: '2030-11-10' },
      { origin: 'BLR', destination: 'HYD', departure_date: '2030-11-14' },
    ]);
    expect(data).not.toHaveProperty('cabin_class');
    expect(data).not.toHaveProperty('max_connections');
  });

  it('never asks for more connections than Duffel accepts', async () => {
    const { requests } = search();
    await settle(duffel().searchFlights({ ...flightRequest, maxStops: 5 }));
    expect((requests[0]!.body as { data: { max_connections: number } }).data.max_connections).toBe(2);
  });

  it('refuses a search with nobody travelling, and makes no request', async () => {
    const { requests } = search();
    const res = failure(await duffel().searchFlights({ ...flightRequest, party: { adults: 0, children: 0, infants: 0 } }));
    expect(res.status).toBe('invalid_request');
    expect(requests).toHaveLength(0);
  });

  it('cannot search without an airport code and says which place lacks one', async () => {
    const { requests } = search();
    const res = failure(await duffel().searchFlights({ ...flightRequest, origin: place('Nowhere', 1, 1) }));
    expect(res.status).toBe('unsupported_route');
    expect(res.message).toContain('Nowhere');
    expect(requests).toHaveLength(0);
  });
});

describe('Duffel response mapping', () => {
  it('maps offers, cheapest first, and keeps only the offer id for re-pricing', async () => {
    search();
    const res = await settle(duffel().searchFlights(flightRequest));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.data.map((o) => o.totalPrice)).toEqual([
      { amount: 720_050, currency: 'INR' },
      { amount: 960_000, currency: 'INR' },
    ]);
    const [viaChennai, direct] = res.data;
    expect(direct!.id).toBe('duffel-flight:HYD-BLR-2030-11-10:off_fixture_direct');
    expect(direct!.mode).toBe('flight');
    expect(direct!.pricePerTraveler).toEqual({ amount: 480_000, currency: 'INR' });
    expect(direct!.refundable).toBe(false);
    expect(direct!.transfers).toBe(0);
    expect(direct!.totalDurationMinutes).toBe(75);
    expect(direct!.segments[0]).toMatchObject({
      operatorCode: 'FX',
      operatorName: 'Fixture Air',
      serviceNumber: 'FX123',
      departureAt: '2030-11-10T08:00:00',
      durationMinutes: 75,
      vehicleType: '320',
      origin: { code: 'HYD', terminal: '1', timezone: 'Asia/Kolkata' },
    });
    expect(direct!.fareClasses[0]).toMatchObject({ cabin: 'economy', label: 'Economy Basic', checkedBagsIncluded: 1 });
    expect(direct!.revalidationToken).toBe('off_fixture_direct');
    expect(direct!.provenance).toMatchObject({
      provider: 'duffel',
      providerLabel: 'Duffel (test mode)',
      validUntil: '2030-11-01T12:00:00.000Z',
    });
    expect(viaChennai!.transfers).toBe(1);
    expect(viaChennai!.totalDurationMinutes).toBe(270);
    expect(viaChennai!.refundable).toBe(true);
    expect(viaChennai!.cancellationPolicy).toBe('Refundable before departure with a penalty of 500.00 INR.');
    // The fixture states nothing about bags for this fare: that stays unknown.
    expect(viaChennai!.baggageSummary).toBeNull();
    expect(viaChennai!.fareClasses[0]!.checkedBagsIncluded).toBeNull();
  });

  it('labels live mode as live and test mode as test', async () => {
    search();
    expect(duffel({ environment: 'live' }).descriptor.label).toBe('Duffel');
    expect(duffel().descriptor.label).toBe('Duffel (test mode)');
  });

  it('applies the carrier and price limits Duffel cannot, and the result limit', async () => {
    search();
    const only = await settle(duffel().searchFlights({ ...flightRequest, preferredCarriers: ['fx'] }));
    if (!isOk(only)) throw new Error('expected ok');
    expect(only.data.map((o) => o.revalidationToken)).toEqual(['off_fixture_direct']);

    search();
    const without = await settle(duffel().searchFlights({ ...flightRequest, excludedCarriers: ['FX'] }));
    if (!isOk(without)) throw new Error('expected ok');
    expect(without.data.map((o) => o.revalidationToken)).toEqual(['off_fixture_oneStop']);

    search();
    const cheap = await settle(duffel().searchFlights({ ...flightRequest, maxPrice: 8000 }));
    if (!isOk(cheap)) throw new Error('expected ok');
    expect(cheap.data).toHaveLength(1);

    search();
    const one = await settle(duffel().searchFlights({ ...flightRequest, limit: 1 }));
    if (!isOk(one)) throw new Error('expected ok');
    expect(one.data).toHaveLength(1);
  });

  it('keeps an offer priced in another currency as it is, so the planner can set it aside', async () => {
    const body = fixture<{ data: { offers: Array<Record<string, unknown>> } }>('duffel/offer-request.json');
    body.data.offers[0]!['total_currency'] = 'USD';
    search(json(body, 201));
    const res = await settle(duffel().searchFlights(flightRequest));
    if (!isOk(res)) throw new Error('expected ok');
    expect(res.data.find((o) => o.revalidationToken === 'off_fixture_direct')!.totalPrice.currency).toBe('USD');
  });

  it('reports an empty answer as empty, not as a failure', async () => {
    search(json({ data: { id: 'orq_x', offers: [] } }, 201));
    const res = await settle(duffel().searchFlights(flightRequest));
    expect(res.status).toBe('no_availability');
    expect(classOf(res)).toBe('empty');
  });

  it('keeps the good offers and says how many were left out', async () => {
    const body = fixture<{ data: { offers: Array<Record<string, unknown>> } }>('duffel/offer-request.json');
    delete body.data.offers[0]!['total_amount'];
    search(json(body, 201));
    const res = await settle(duffel().searchFlights(flightRequest));
    if (!isOk(res)) throw new Error('expected ok');
    expect(res.data).toHaveLength(1);
    expect(res.warnings.join(' ')).toMatch(/1 flight offer\(s\) from .* could not be read/);
  });

  it('is unusable when no offer has the documented shape', async () => {
    const body = fixture<{ data: { offers: Array<Record<string, unknown>> } }>('duffel/offer-request.json');
    body.data.offers = body.data.offers.map((o) => ({ ...o, total_amount: 'not-a-number' }));
    search(json(body, 201));
    const res = await settle(duffel().searchFlights(flightRequest));
    expect(res.status).toBe('invalid_response');
    expect(classOf(res)).toBe('unusable');
  });

  it('is unusable when the offer list is missing, or the body is not JSON', async () => {
    search(json({ data: {} }, 201));
    expect((await settle(duffel().searchFlights(flightRequest))).status).toBe('invalid_response');
    search(text('<html>Bad gateway page</html>', 200));
    const res = failure(await settle(duffel().searchFlights(flightRequest)));
    expect(res.status).toBe('invalid_response');
    expect(res.message).not.toMatch(/could not be reached/);
  });
});

describe('Duffel failures', () => {
  it('reports refused credentials as a configuration problem, not an outage', async () => {
    search(json({ errors: [{ type: 'authentication_error', code: 'access_token_not_found' }] }, 401));
    const res = failure(await settle(duffel().searchFlights(flightRequest)));
    expect(res.status).toBe('not_configured');
    expect(classOf(res)).toBe('not_available');
    expect(res.message).toMatch(/Duffel refused the request \(access_token_not_found\)/);
  });

  it("passes on Duffel's own reason when the token lacks a permission, so the fix is clear", async () => {
    search(
      json(
        {
          errors: [
            {
              type: 'authentication_error',
              code: 'insufficient_permissions',
              title: 'Insufficient permissions',
              message: "This endpoint requires a token with 'air.offer_requests.create' permission.",
            },
          ],
        },
        403,
      ),
    );
    const res = failure(await settle(duffel().searchFlights(flightRequest)));
    expect(res.status).toBe('not_configured');
    expect(res.message).toMatch(/not allowed to search flights/);
    expect(res.message).toContain("'air.offer_requests.create'");
    expect(res.message).toContain('DUFFEL_ACCESS_TOKEN');
    expect(res.message).not.toContain(TOKEN);
  });

  it('names an unknown refusal by its code, and falls back to the general wording without one', async () => {
    search(json({ errors: [{ code: 'access_token_not_found', message: 'nope' }] }, 401));
    expect(failure(await settle(duffel().searchFlights(flightRequest))).message).toMatch(/access_token_not_found/);
    search(text('not json', 401));
    expect(failure(await settle(duffel().searchFlights(flightRequest))).message).toMatch(/rejected the configured credentials/);
  });

  it('reports rate limiting with when to try again, and does not retry it', async () => {
    const { requests } = search(json({ errors: [] }, 429, { 'retry-after': '7' }));
    const res = failure(await settle(duffel().searchFlights(flightRequest)));
    expect(res.status).toBe('rate_limited');
    expect(res.retryAfterSeconds).toBe(7);
    expect(classOf(res)).toBe('rate_limited');
    expect(requests).toHaveLength(1);
  });

  it('reports a rejected search as an invalid request', async () => {
    search(json({ errors: [{ type: 'validation_error', message: 'bad slice' }] }, 422));
    expect((await settle(duffel().searchFlights(flightRequest))).status).toBe('invalid_request');
  });

  it('reports a server error as a failure, and does not repeat a search it may already have made', async () => {
    const { requests } = search(json({ errors: [] }, 500));
    const res = await settle(duffel().searchFlights(flightRequest));
    expect(res.status).toBe('unavailable');
    expect(classOf(res)).toBe('failed');
    expect(requests).toHaveLength(1);
  });

  it('reports a call that never answers as a timeout', async () => {
    search(hang);
    const res = await settle(duffel().searchFlights(flightRequest), 5_000);
    expect(res.status).toBe('timeout');
    expect(classOf(res)).toBe('timed_out');
  });

  it('reports a connection that fails as unreachable', async () => {
    search(networkError);
    const res = failure(await settle(duffel().searchFlights(flightRequest)));
    expect(res.status).toBe('unavailable');
    expect(res.message).toMatch(/could not be reached/);
  });

  it('stops when the caller cancels, and says the planner caused it', async () => {
    search(hang);
    const controller = new AbortController();
    const pending = duffel().searchFlights({ ...flightRequest, signal: controller.signal });
    controller.abort();
    const res = failure(await settle(pending));
    expect(res.status).toBe('timeout');
    expect(res.local).toBe(true);
  });

  it('says so when it has no token, and makes no request', async () => {
    const { requests } = serve({});
    const res = await duffel({ accessToken: '' }).searchFlights(flightRequest);
    expect(res.status).toBe('not_configured');
    expect(classOf(res)).toBe('not_available');
    expect(res.status === 'not_configured' && res.message).toMatch(/DUFFEL_ACCESS_TOKEN/);
    expect(requests).toHaveLength(0);
  });

  it('never puts the token in a result, a message or a warning', async () => {
    const replies = [
      json({ errors: [{ message: 'nope' }] }, 401),
      json({ errors: [] }, 429),
      json({ errors: [] }, 500),
      json({ errors: [] }, 422),
      text('garbage', 200),
      networkError,
      json(fixture('duffel/offer-request.json'), 201),
    ];
    for (const reply of replies) {
      search(reply);
      const res = await settle(duffel().searchFlights(flightRequest));
      expect(JSON.stringify(res)).not.toContain(TOKEN);
      expect(JSON.stringify(res)).not.toContain('duffel_test_');
    }
  });
});

describe('Duffel re-pricing (a read, never an order)', () => {
  const offer = () => fixture<{ data: { offers: unknown[] } }>('duffel/offer-request.json').data.offers[0];

  it('re-reads the offer by id', async () => {
    const { requests } = serve({ '/air/offers/off_fixture_direct': json({ data: offer() }) });
    const res = await settle(duffel().revalidateFlight('off_fixture_direct'));
    if (!isOk(res)) throw new Error('expected ok');
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.url.pathname).toBe('/air/offers/off_fixture_direct');
    expect(requests[0]!.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(res.data.totalPrice).toEqual({ amount: 960_000, currency: 'INR' });
    expect(res.data.pricePerTraveler).toEqual({ amount: 480_000, currency: 'INR' });
  });

  it('says the fare is gone when Duffel no longer has the offer', async () => {
    serve({ '/air/offers/': json({ errors: [{ code: 'not_found' }] }, 404) });
    const res = failure(await settle(duffel().revalidateFlight('off_fixture_direct')));
    expect(res.status).toBe('booking_unavailable');
  });

  it('refuses a token that is not an offer id, and makes no request', async () => {
    const { requests } = serve({});
    for (const bad of ['../orders', 'off_1/../../orders', '{"id":"1"}', '']) {
      expect(failure(await duffel().revalidateFlight(bad)).status).toBe('invalid_request');
    }
    expect(requests).toHaveLength(0);
  });
});

describe('Duffel airports', () => {
  it('asks for places around the point, keeps airports only, nearest first', async () => {
    const { requests } = serve({ '/places/suggestions': json(fixture('duffel/places.json')) });
    const res = await settle(duffel().nearestAirports({ lat: 17.385, lon: 78.4867 }));
    if (!isOk(res)) throw new Error('expected ok');
    expect(res.data.map((a) => a.iataCode)).toEqual(['BPM', 'HYD']);
    expect(res.data[0]!.distanceKm).toBeLessThan(res.data[1]!.distanceKm);
    const q = requests[0]!.url.searchParams;
    expect(q.get('lat')).toBe('17.385');
    expect(q.get('lng')).toBe('78.4867');
    expect(q.get('rad')).toBe('300000');
  });

  it('distinguishes empty from unusable', async () => {
    serve({ '/places/suggestions': json({ data: [] }) });
    expect((await settle(duffel().nearestAirports({ lat: 0, lon: 0 }))).status).toBe('no_availability');
    serve({ '/places/suggestions': json({ data: [{ nope: true }] }) });
    expect((await settle(duffel().nearestAirports({ lat: 0, lon: 0 }))).status).toBe('invalid_response');
    serve({ '/places/suggestions': json({ data: [{ type: 'city', iata_code: 'HYD', name: 'Hyderabad' }] }) });
    expect((await settle(duffel().nearestAirports({ lat: 0, lon: 0 }))).status).toBe('no_availability');
  });
});

describe('Duffel configuration', () => {
  const TEST = 'duffel_test_abc';
  const LIVE = 'duffel_live_abc';

  it('is off without a token, so the application starts without credentials', () => {
    expect(loadProvidersEnv({}).duffel).toBeNull();
    expect(loadProvidersEnv({ DUFFEL_ENVIRONMENT: 'live' }).duffel).toBeNull();
  });

  it('defaults to test mode', () => {
    expect(loadProvidersEnv({ DUFFEL_ACCESS_TOKEN: TEST }).duffel).toEqual({
      accessToken: TEST,
      environment: 'test',
      minIntervalMs: 500,
    });
  });

  it('will not use a live token unless live mode is asked for by name', () => {
    expect(() => loadProvidersEnv({ DUFFEL_ACCESS_TOKEN: LIVE })).toThrow(/live token but DUFFEL_ENVIRONMENT is "test"/);
    expect(loadProvidersEnv({ DUFFEL_ACCESS_TOKEN: LIVE, DUFFEL_ENVIRONMENT: 'live' }).duffel?.environment).toBe('live');
  });

  it('will not call a test token live, in production or anywhere', () => {
    expect(() =>
      loadProvidersEnv({ NODE_ENV: 'production', DUFFEL_ACCESS_TOKEN: TEST, DUFFEL_ENVIRONMENT: 'live' }),
    ).toThrow(/test token but DUFFEL_ENVIRONMENT is "live"/);
  });

  it('rejects a value that is not a Duffel token or mode, without repeating the token', () => {
    const odd = 'sk-this-is-some-other-secret';
    let message = '';
    try {
      loadProvidersEnv({ DUFFEL_ACCESS_TOKEN: odd });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/duffel_test_ or duffel_live_/);
    expect(message).not.toContain(odd);
    expect(() => loadProvidersEnv({ DUFFEL_ENVIRONMENT: 'sandbox' })).toThrow(/"test" or "live"/);
  });

  it('puts Duffel on flights, and leaves Amadeus on hotels only', () => {
    const registry = new ProviderRegistry(
      loadProvidersEnv({
        DUFFEL_ACCESS_TOKEN: TEST,
        AMADEUS_CLIENT_ID: 'id',
        AMADEUS_CLIENT_SECRET: 'secret',
      }),
    );
    expect(registry.flights.map((p) => p.descriptor.id)).toEqual(['duffel']);
    expect(registry.hotels.map((p) => p.descriptor.id)).toEqual(['amadeus']);
    expect(registry.duffel).not.toBeNull();
  });

  it('does not put Amadeus on flights even when only Amadeus is configured', () => {
    const registry = new ProviderRegistry(loadProvidersEnv({ AMADEUS_CLIENT_ID: 'id', AMADEUS_CLIENT_SECRET: 'secret' }));
    expect(registry.flights).toHaveLength(0);
    const note = registry.missingCapabilityNote('flights', ['duffel']);
    expect(note.message).toMatch(/DUFFEL_ACCESS_TOKEN/);
    expect(registry.disabled.find((d) => d.id === 'duffel')?.requiredEnv).toEqual(['DUFFEL_ACCESS_TOKEN']);
  });
});
