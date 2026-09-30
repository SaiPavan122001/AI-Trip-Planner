import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isOk } from '@trip/shared';
import { resetRetryBudgets } from '../http.js';
import { ProviderRegistry } from '../registry.js';
import { loadProvidersEnv } from '../config.js';
import { fixture, json, serve, settle, type Reply } from './support/fixtures.js';

/**
 * The registry as the API builds it: real adapters, the default policy, the
 * cache and the fallback chain, with only the network stubbed. What is checked
 * here is that the pieces are actually connected, not that each works alone.
 */

const env = (extra: Record<string, string> = {}) =>
  loadProvidersEnv({
    NOMINATIM_USER_AGENT: 'wayfare-test (nobody@example.invalid)',
    NOMINATIM_BASE_URL: 'https://nominatim.example.test',
    NOMINATIM_MIN_INTERVAL_MS: '0',
    OSRM_BASE_URL: 'https://osrm.example.test',
    OSRM_MIN_INTERVAL_MS: '0',
    GOOGLE_MAPS_API_KEY: 'placeholder-key',
    GOOGLE_MAPS_MIN_INTERVAL_MS: '0',
    ...extra,
  });

const place = (id: string, name: string, lat: number, lon: number) => ({
  id,
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
const hyderabad = place('hyd', 'Hyderabad', 17.385, 78.4867);
const warangal = place('wgl', 'Warangal', 17.9689, 79.5941);
const drive = { origin: hyderabad, destination: warangal, date: '2030-11-10', departLocalTime: '08:00', currency: 'INR' };

beforeEach(() => {
  resetRetryBudgets();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('routing with a fallback', () => {
  it('measures a drive with the preferred provider, and says nothing about the other', async () => {
    const { requests } = serve({ computeRoutes: json(fixture('google/routes.json')), '/route/v1/driving': json(fixture('osrm/route.json')) });
    const registry = new ProviderRegistry(env());
    const res = await settle(registry.selfDrive!.estimate(drive));
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.data.provenance.provider).toBe('self-drive');
      expect(res.warnings.join(' ')).not.toMatch(/answered instead/);
    }
    expect(requests.some((r) => r.url.pathname.includes('/route/v1/'))).toBe(false); // OSRM was not asked
  });

  it('falls back to the next provider when the preferred one is failing, and the answer says so', async () => {
    const { requests } = serve({
      computeRoutes: json({ error: 'backend error' }, 503),
      '/route/v1/driving': json(fixture('osrm/route.json')),
    });
    const registry = new ProviderRegistry(env({ PROVIDER_MAX_RETRIES: '0' }));
    const res = await settle(registry.selfDrive!.estimate(drive));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(requests.map((r) => r.url.host)).toEqual(['routes.googleapis.com', 'osrm.example.test']);
    // A real distance and duration from OSRM, not an invented one.
    expect(res.data.totalDurationMinutes).toBeGreaterThan(0);
    const all = res.warnings.join(' ');
    expect(all).toMatch(/come from .*OSRM/i); // which provider measured it
    expect(all).toMatch(/Google/i);
    expect(all).toMatch(/answered instead/);
  });

  it('when every routing provider fails, the drive fails and lists both, with no invented figures', async () => {
    serve({ computeRoutes: json({}, 503), '/route/v1/driving': json({}, 502) });
    const registry = new ProviderRegistry(env({ PROVIDER_MAX_RETRIES: '0' }));
    const res = await settle(registry.selfDrive!.estimate(drive));
    expect(isOk(res)).toBe(false);
    if (!isOk(res)) {
      expect(res.capability).toBeDefined();
      expect(res.message).toMatch(/also failed/);
    }
  });

  it('falls back when the preferred provider sends nonsense', async () => {
    serve({ computeRoutes: json({ routes: 'not a list' }), '/route/v1/driving': json(fixture('osrm/route.json')) });
    const registry = new ProviderRegistry(env({ PROVIDER_MAX_RETRIES: '0' }));
    const res = await settle(registry.selfDrive!.estimate(drive));
    expect(isOk(res)).toBe(true);
  });

  it('stops asking a provider that keeps failing, and goes straight to the other', async () => {
    const { requests } = serve({ computeRoutes: json({}, 503), '/route/v1/driving': json(fixture('osrm/route.json')) });
    const registry = new ProviderRegistry(env({ PROVIDER_MAX_RETRIES: '0', PROVIDER_CIRCUIT_FAILURE_THRESHOLD: '3', CACHE_ENABLED: 'false' }));
    for (let i = 0; i < 3; i += 1) await settle(registry.selfDrive!.estimate({ ...drive, date: `2030-11-1${i}` }));
    const before = requests.filter((r) => r.url.host === 'routes.googleapis.com').length;
    expect(before).toBe(3);
    const res = await settle(registry.selfDrive!.estimate({ ...drive, date: '2030-11-20' }));
    expect(requests.filter((r) => r.url.host === 'routes.googleapis.com').length).toBe(3); // not asked a fourth time
    expect(isOk(res) && res.warnings.join(' ')).toMatch(/not asked/);
    expect(registry.policy).toBeDefined();
  });
});

describe('the cache is connected', () => {
  it('asks the place lookup once for the same place typed twice', async () => {
    const { requests } = serve({ '/search': json(fixture('nominatim/search.json')) });
    const registry = new ProviderRegistry(env());
    const geocoder = registry.geocoding[0]!;
    await settle(geocoder.resolvePlace('Hyderabad'));
    await settle(geocoder.resolvePlace('  hyderabad '));
    expect(requests).toHaveLength(1);
  });

  it('asks again when caching is switched off', async () => {
    const { requests } = serve({ '/search': json(fixture('nominatim/search.json')) });
    const registry = new ProviderRegistry(env({ CACHE_ENABLED: 'false' }));
    await settle(registry.geocoding[0]!.resolvePlace('Hyderabad'));
    await settle(registry.geocoding[0]!.resolvePlace('Hyderabad'));
    expect(requests).toHaveLength(2);
    expect(registry.cache).toBeNull();
  });

  it('never caches flights or hotels: their prices change by the minute', () => {
    const registry = new ProviderRegistry(env({ AMADEUS_CLIENT_ID: 'placeholder', AMADEUS_CLIENT_SECRET: 'placeholder' }));
    // The Amadeus adapter is registered as itself, not behind a caching wrapper.
    expect(registry.flights[0]!.constructor.name).toBe('AmadeusProvider');
    expect(registry.hotels[0]!.constructor.name).toBe('AmadeusProvider');
  });

  it('keeps the time to live from configuration, and refuses nonsense', async () => {
    expect(env({ CACHE_TTL_GEOCODING_S: '60' }).cache.geocodingTtlMs).toBe(60_000);
    expect(() => env({ CACHE_TTL_ROUTING_S: '0' })).toThrow(/CACHE_TTL_ROUTING_S/);
    expect(() => env({ PROVIDER_CIRCUIT_FAILURE_THRESHOLD: 'often' })).toThrow(/PROVIDER_CIRCUIT_FAILURE_THRESHOLD/);
  });
});

/** A failure Google answers with, for the table above. */
export const unused: Reply = json({});
