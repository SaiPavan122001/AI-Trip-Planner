import { describe, expect, it } from 'vitest';
import { fail, isOk, ok, type Place, type ProviderProvenance } from '@trip/shared';
import { BusEstimateProvider, type BusFareModel } from '../adapters/bus-estimate.js';
import { OsrmTransferProvider } from '../adapters/osrm.js';
import { loadProvidersEnv } from '../config.js';
import { ProviderRegistry } from '../registry.js';
import type { RouteRequest, RoutingProvider, SurfaceSearchRequest, TransferSearchRequest } from '../types.js';

/**
 * Bus fares and local taxi/auto fares are ESTIMATES from configured
 * assumptions. These tests pin down that they are labelled as such, say where
 * the numbers came from, and never pretend to be a timetable, a quote or an
 * availability check.
 */

const prov: ProviderProvenance = {
  provider: 'fake-routing',
  providerLabel: 'Fake routing',
  retrievedAt: '2026-01-01T00:00:00.000Z',
  validUntil: null,
  searchId: null,
  attribution: null,
};

const routing = (distanceKm: number, durationMinutes: number, configured = true): RoutingProvider => ({
  descriptor: { id: 'fake-routing', label: 'Fake routing', kinds: ['routing'], requiredEnv: [], coverage: 'global', docsUrl: null, attribution: null },
  isConfigured: () => configured,
  health: async () => ok({ ok: true as const, latencyMs: 1 }, prov),
  route: async (_req: RouteRequest) => ok({ distanceKm, durationMinutes, geometry: null }, prov),
});

const place = (name: string, lat: number, lon: number): Place => ({
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
});

const model: BusFareModel = {
  currency: 'INR',
  source: 'illustrative test numbers, not a real tariff',
  asOf: '2026-01-01',
  baseFare: 0,
  assumedDepartureTime: '08:00',
  categories: {
    ordinary: { label: 'Ordinary bus', perKm: 1.5, averageSpeedKmh: 40, minimumFare: 20 },
    ac_sleeper: { label: 'AC sleeper', perKm: 2.5, averageSpeedKmh: 50, minimumFare: 50 },
  },
};

const busRequest: SurfaceSearchRequest = {
  origin: place('Hyderabad', 17.385, 78.4867),
  destination: place('Bengaluru', 12.9716, 77.5946),
  date: '2030-11-10',
  party: { adults: 2, children: 0, infants: 1 },
  currency: 'INR',
  classCode: null,
  limit: 10,
};

describe('bus fare estimates', () => {
  it('works the fare out from distance and the configured model, per paying traveller', async () => {
    const res = await new BusEstimateProvider(routing(200, 240), model).searchBuses(busRequest);
    if (!isOk(res)) throw new Error('expected ok');
    expect(res.data.map((o) => o.selectedFareCode)).toEqual(['ordinary', 'ac_sleeper']);
    const [ordinary, ac] = res.data;
    // 200 km at 1.5 each, for two paying travellers (the infant is not charged).
    expect(ordinary!.pricePerTraveler).toEqual({ amount: 30_000, currency: 'INR' });
    expect(ordinary!.totalPrice).toEqual({ amount: 60_000, currency: 'INR' });
    expect(ordinary!.totalDurationMinutes).toBe(300);
    expect(ac!.totalPrice).toEqual({ amount: 100_000, currency: 'INR' });
  });

  it('applies the minimum fare on a short trip', async () => {
    const res = await new BusEstimateProvider(routing(5, 15), model).searchBuses(busRequest);
    if (!isOk(res)) throw new Error('expected ok');
    expect(res.data[0]!.pricePerTraveler.amount).toBe(2_000);
  });

  it('is plainly an estimate: no operator, no service, no seats, no booking, a stated source and date', async () => {
    const res = await new BusEstimateProvider(routing(200, 240), model).searchBuses(busRequest);
    if (!isOk(res)) throw new Error('expected ok');
    const offer = res.data[0]!;
    expect(offer.segments[0]).toMatchObject({ operatorName: null, operatorCode: null, serviceNumber: null });
    expect(offer.revalidationToken).toBeNull();
    expect(offer.refundable).toBeNull();
    expect(offer.fareClasses[0]!.availability).toBeNull();
    expect(offer.fareClasses[0]!.label).toMatch(/estimated fare/);
    expect(offer.provenance.providerLabel).toMatch(/not a timetable or a quote/);
    expect(offer.itemisedFees[0]).toMatchObject({ isEstimate: true, included: true });
    expect(offer.itemisedFees[0]!.basis).toContain('illustrative test numbers');
    expect(offer.itemisedFees[0]!.basis).toContain('2026-01-01');
    const warnings = res.warnings.join(' ');
    expect(warnings).toMatch(/estimates from configured assumptions/);
    expect(warnings).toMatch(/No operator, timetable or seat availability/);
    expect(offer.segments[0]!.departureAt).toBe('2030-11-10T08:00:00+05:30');
  });

  it('can be narrowed to one category, and says when none matches', async () => {
    const one = await new BusEstimateProvider(routing(100, 100), model).searchBuses({ ...busRequest, classCode: 'ac_sleeper' });
    if (!isOk(one)) throw new Error('expected ok');
    expect(one.data).toHaveLength(1);
    const none = await new BusEstimateProvider(routing(100, 100), model).searchBuses({ ...busRequest, classCode: 'luxury' });
    expect(none.status).toBe('no_availability');
  });

  it('will not estimate in a currency other than the one it was configured in, or without routing', async () => {
    expect((await new BusEstimateProvider(routing(100, 100), model).searchBuses({ ...busRequest, currency: 'USD' })).status).toBe(
      'unsupported_route',
    );
    expect((await new BusEstimateProvider(routing(100, 100, false), model).searchBuses(busRequest)).status).toBe('not_configured');
  });

  it('passes a routing failure on as it is', async () => {
    const failing: RoutingProvider = {
      ...routing(1, 1),
      route: async () => fail('unavailable', 'fake-routing', 'Fake routing', 'down'),
    };
    expect((await new BusEstimateProvider(failing, model).searchBuses(busRequest)).status).toBe('unavailable');
  });
});

describe('bus fare configuration', () => {
  const good = JSON.stringify(model);
  const withOsrm = { OSRM_BASE_URL: 'https://router.project-osrm.org' };

  it('has no default: with no model there is no estimate, and buses are reported as not searched', () => {
    const registry = new ProviderRegistry(loadProvidersEnv(withOsrm));
    expect(registry.buses).toHaveLength(0);
    expect(registry.missingCapabilityNote('buses', ['bus']).message).toMatch(/BUS_FARE_ESTIMATE|No bus provider/);
  });

  it('registers the estimate for India only, and says it is an estimate when the capability is queried', () => {
    const registry = new ProviderRegistry(loadProvidersEnv({ ...withOsrm, BUS_FARE_ESTIMATE: good }));
    expect(registry.buses.map((p) => p.descriptor.id)).toEqual(['bus-estimate']);
    expect(registry.busesFor('IN')).toHaveLength(1);
    expect(registry.busesFor('FR')).toHaveLength(0);
    expect(registry.disabled.find((d) => d.id === 'bus')?.capabilities.buses).toMatch(/estimated/);
  });

  it('steps aside for a real bus provider', () => {
    const registry = new ProviderRegistry(
      loadProvidersEnv({ ...withOsrm, BUS_FARE_ESTIMATE: good, BUS_PROVIDER_URL: 'https://bus.example.com' }),
    );
    expect(registry.buses.map((p) => p.descriptor.id)).not.toContain('bus-estimate');
  });

  it('refuses a model that is not in rupees, names no source, or has no categories', () => {
    expect(() => loadProvidersEnv({ BUS_FARE_ESTIMATE: JSON.stringify({ ...model, currency: 'USD' }) })).toThrow(/BUS_FARE_ESTIMATE is invalid/);
    expect(() => loadProvidersEnv({ BUS_FARE_ESTIMATE: JSON.stringify({ ...model, source: '' }) })).toThrow(/BUS_FARE_ESTIMATE is invalid/);
    expect(() => loadProvidersEnv({ BUS_FARE_ESTIMATE: JSON.stringify({ ...model, categories: {} }) })).toThrow(/BUS_FARE_ESTIMATE is invalid/);
    expect(() => loadProvidersEnv({ BUS_FARE_ESTIMATE: '{not json' })).toThrow(/not valid JSON/);
  });
});

describe('local taxi and auto-rickshaw estimates', () => {
  const tariff = { currency: 'INR', baseFare: 50, perKm: 18, perMinute: 2, nightMultiplier: 1.25, minimumFare: 300, source: 'test tariff', asOf: '2026-01-01' };
  const request: TransferSearchRequest = {
    from: { name: 'A', coordinates: { lat: 12.9, lon: 77.5 } },
    to: { name: 'B', coordinates: { lat: 12.95, lon: 77.6 } },
    at: '2030-11-10T05:00:00Z',
    timezone: 'Asia/Kolkata',
    party: { adults: 4, children: 0, infants: 0 },
    luggagePieces: 2,
    accessibleRequired: false,
    currency: 'INR',
  };

  it('prices a short ride at the minimum fare, and labels it an estimate that is not a quote', async () => {
    const res = await new OsrmTransferProvider(routing(2, 5), { INR: tariff }).searchTransfers(request);
    if (!isOk(res)) throw new Error('expected ok');
    const taxi = res.data.find((o) => o.mode === 'taxi')!;
    // 50 + 36 + 10 = 96, below the 300 minimum.
    expect(taxi.price).toEqual({ amount: 30_000, currency: 'INR' });
    expect(taxi.priceIsEstimate).toBe(true);
    expect(taxi.quote).toBeNull();
    expect(taxi.estimateBasis).toContain('minimum 300');
    expect(taxi.estimateBasis).toContain('source: test tariff, last checked 2026-01-01');
    expect(taxi.estimateBasis).toMatch(/Not a quote: actual fares vary/);
  });

  it('adds distance and time components above the minimum, and a night multiplier', async () => {
    const day = await new OsrmTransferProvider(routing(20, 40), { INR: tariff }).searchTransfers(request);
    const night = await new OsrmTransferProvider(routing(20, 40), { INR: tariff }).searchTransfers({ ...request, at: '2030-11-10T20:00:00Z' });
    if (!isOk(day) || !isOk(night)) throw new Error('expected ok');
    // 50 + 360 + 80 = 490 a car, one car for... four seats: one car.
    expect(day.data[0]!.price).toEqual({ amount: 49_000, currency: 'INR' });
    // 20:00 UTC is 01:30 in India: the night tariff applies.
    expect(night.data[0]!.price).toEqual({ amount: 61_250, currency: 'INR' });
  });

  it('offers an auto-rickshaw only where one is configured, with its own seats and fare', async () => {
    const without = await new OsrmTransferProvider(routing(5, 15), { INR: tariff }).searchTransfers(request);
    if (!isOk(without)) throw new Error('expected ok');
    expect(without.data.some((o) => o.mode === 'auto_rickshaw')).toBe(false);

    const auto = { ...tariff, baseFare: 30, perKm: 12, perMinute: 0, minimumFare: 40, source: 'auto test tariff' };
    const res = await new OsrmTransferProvider(routing(5, 15), { INR: tariff }, { INR: auto }).searchTransfers(request);
    if (!isOk(res)) throw new Error('expected ok');
    const rickshaw = res.data.find((o) => o.mode === 'auto_rickshaw')!;
    // Four people need two autos of three seats; each is 30 + 60 = 90.
    expect(rickshaw.vehicles).toBe(2);
    expect(rickshaw.price).toEqual({ amount: 18_000, currency: 'INR' });
    expect(rickshaw.priceIsEstimate).toBe(true);
    expect(rickshaw.estimateBasis).toContain('Auto-rickshaw fare estimated');
  });

  it('shows distance and time with no price when no fare model is configured, never a zero', async () => {
    const res = await new OsrmTransferProvider(routing(5, 15), {}).searchTransfers(request);
    if (!isOk(res)) throw new Error('expected ok');
    expect(res.data[0]!.price).toBeNull();
    expect(res.data[0]!.priceIsEstimate).toBe(false);
  });

  it('reads minimum fare, source and date from the environment', () => {
    const env = loadProvidersEnv({
      GROUND_TRANSPORT_TARIFFS: JSON.stringify([tariff]),
      AUTO_RICKSHAW_TARIFFS: JSON.stringify([{ ...tariff, minimumFare: 40 }]),
    });
    expect(env.taxiTariffs['INR']).toMatchObject({ minimumFare: 300, source: 'test tariff', asOf: '2026-01-01' });
    expect(env.autoTariffs['INR']!.minimumFare).toBe(40);
    expect(() => loadProvidersEnv({ AUTO_RICKSHAW_TARIFFS: JSON.stringify([{ ...tariff, currency: 'USD' }]) })).toThrow(/AUTO_RICKSHAW_TARIFFS is invalid/);
  });

  it('builds the transfer provider over whichever routing is configured, Google included', () => {
    const registry = new ProviderRegistry(loadProvidersEnv({ GOOGLE_MAPS_API_KEY: 'g', GROUND_TRANSPORT_TARIFFS: JSON.stringify([tariff]) }));
    expect(registry.groundTransport).toHaveLength(1);
  });
});

describe('bus estimate stops', () => {
  it('gives no position for either end, because no bus stand is known', async () => {
    const res = await new BusEstimateProvider(routing(200, 240), model).searchBuses(busRequest);
    if (!isOk(res)) throw new Error('expected ok');
    expect(res.data[0]!.segments[0]!.origin.coordinates).toBeNull();
    expect(res.data[0]!.segments[0]!.destination.coordinates).toBeNull();
  });
});
