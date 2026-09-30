import { afterEach, describe, expect, it, vi } from 'vitest';
import { isOk, type Place } from '@trip/shared';
import { GenericRailProvider, type GenericSurfaceConfig } from '../adapters/generic-surface.js';

/**
 * The surface-transport contract is what lets an operator plug in a rail or bus
 * API they are authorised to use. These tests pin the guarantees that contract
 * makes to the rest of the planner — above all that a provider which returns
 * something unexpected produces a provider error, never a malformed itinerary.
 */

const config: GenericSurfaceConfig = {
  baseUrl: 'https://rail.example.test',
  apiKey: 'test-key',
  coverage: ['IN'],
  label: 'Test Rail',
  requiredEnv: ['RAIL_PROVIDER_URL'],
  attribution: null,
  minIntervalMs: 0,
  timeoutMs: 5000,
};

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

const request = {
  origin: place('Hyderabad', 17.385, 78.4867),
  destination: place('Bengaluru', 12.9716, 77.5946),
  date: '2026-11-10',
  party: { adults: 2, children: 0, infants: 0 },
  currency: 'INR',
  classCode: null,
  limit: 20,
};

const validService = {
  id: '12785',
  currency: 'INR',
  transfers: 0,
  legs: [
    {
      operatorName: 'Indian Railways',
      serviceNumber: '12785',
      originName: 'Kacheguda',
      originCode: 'KCG',
      destinationName: 'KSR Bengaluru',
      destinationCode: 'SBC',
      departureAt: '2026-11-10T19:05:00+05:30',
      arrivalAt: '2026-11-11T05:40:00+05:30',
      durationMinutes: 635,
    },
  ],
  fares: [
    { code: 'SL', label: 'Sleeper', priceMajor: 495, availability: 42, refundable: true },
    { code: '3A', label: 'AC 3 Tier', priceMajor: 1310, availability: 8 },
  ],
};

function mockResponse(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('generic surface provider', () => {
  it('reports not_configured rather than failing when no endpoint is set', async () => {
    const provider = new GenericRailProvider({ ...config, baseUrl: '' });
    const result = await provider.searchTrains(request);

    expect(result.status).toBe('not_configured');
    if (!isOk(result)) {
      // The message has to tell an operator exactly what to set.
      expect(result.message).toMatch(/RAIL_PROVIDER_URL/);
      expect(result.message).toMatch(/No timetable is shown/i);
    }
  });

  it('passes operator fare classes through untranslated', async () => {
    mockResponse({ services: [validService] });
    const result = await new GenericRailProvider(config).searchTrains(request);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const [offer] = result.data;
      // "SL" and "3A" are Indian Railways' own codes. Normalising them into
      // invented tiers would misrepresent what the traveller is buying.
      expect(offer!.fareClasses.map((f) => f.code)).toEqual(['SL', '3A']);
      expect(offer!.fareClasses[0]!.label).toBe('Sleeper');
      expect(offer!.selectedFareCode).toBe('SL');
    }
  });

  it('prices the offer from the cheapest fare and keeps the rest visible', async () => {
    mockResponse({ services: [validService] });
    const result = await new GenericRailProvider(config).searchTrains(request);

    if (isOk(result)) {
      expect(result.data[0]!.totalPrice).toEqual({ amount: 49500, currency: 'INR' });
      expect(result.data[0]!.fareClasses).toHaveLength(2);
    }
  });

  it('detects an overnight service from the local dates', async () => {
    mockResponse({ services: [validService] });
    const result = await new GenericRailProvider(config).searchTrains(request);

    if (isOk(result)) expect(result.data[0]!.overnight).toBe(true);
  });

  it('carries availability through exactly as reported, including labels', async () => {
    mockResponse({
      services: [
        {
          ...validService,
          fares: [
            { code: '2A', label: 'AC 2 Tier', priceMajor: 1875, availabilityLabel: 'RAC 3' },
          ],
        },
      ],
    });
    const result = await new GenericRailProvider(config).searchTrains(request);

    if (isOk(result)) {
      // "RAC 3" is not a number, and inventing one would be a lie about seats.
      expect(result.data[0]!.fareClasses[0]!.availabilityLabel).toBe('RAC 3');
      expect(result.data[0]!.fareClasses[0]!.availability).toBeNull();
    }
  });

  it('discards a response that does not match the contract', async () => {
    // A leg with no departure time cannot be scheduled. Accepting it would
    // push the failure somewhere far from its cause.
    mockResponse({
      services: [{ ...validService, legs: [{ originName: 'A', destinationName: 'B' }] }],
    });
    const result = await new GenericRailProvider(config).searchTrains(request);

    // A malformed answer is its own outcome (unusable), not an outage.
    expect(result.status).toBe('invalid_response');
    if (!isOk(result)) expect(result.message).toMatch(/documented provider contract/i);
  });

  it('distinguishes "no services" from "could not look"', async () => {
    mockResponse({ services: [] });
    const result = await new GenericRailProvider(config).searchTrains(request);

    expect(result.status).toBe('no_availability');
    if (!isOk(result)) expect(result.message).toMatch(/no services on 2026-11-10/i);
  });

  it('maps an upstream rejection to a provider failure, not an exception', async () => {
    mockResponse({ message: 'nope' }, 503);
    const result = await new GenericRailProvider(config).searchTrains(request);

    expect(result.status).toBe('unavailable');
  });

  it('reports rate limiting distinctly so the caller can back off', async () => {
    mockResponse({}, 429);
    const result = await new GenericRailProvider(config).searchTrains(request);

    expect(result.status).toBe('rate_limited');
  });

  it('treats rejected credentials as a configuration problem', async () => {
    mockResponse({}, 401);
    const result = await new GenericRailProvider(config).searchTrains(request);

    expect(result.status).toBe('not_configured');
  });

  it('attaches provenance to every success', async () => {
    mockResponse({ services: [validService], searchId: 'abc123' });
    const result = await new GenericRailProvider(config).searchTrains(request);

    if (isOk(result)) {
      expect(result.provenance.providerLabel).toBe('Test Rail');
      expect(result.provenance.searchId).toBe('abc123');
      expect(Date.parse(result.provenance.retrievedAt)).not.toBeNaN();
    }
  });
});
