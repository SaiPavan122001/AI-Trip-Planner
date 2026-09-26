import { afterEach, describe, expect, it } from 'vitest';
import { ok, type Place, type TransportOffer } from '@trip/shared';
import { SelfDriveProvider } from '../adapters/self-drive.js';
import type { RouteRequest, RoutingProvider } from '../types.js';

/**
 * Self-drive times must be right wherever the server runs. The departure is a
 * wall-clock time in the origin's zone and the arrival is reported in the
 * destination's zone; the server's own zone must play no part.
 */

const place = (id: string, name: string, timezone: string, lat: number, lon: number): Place => ({
  id,
  name,
  displayName: name,
  coordinates: { lat, lon },
  countryCode: 'XX',
  countryName: 'Test',
  timezone,
  airports: [],
  source: 'test',
  resolvedAt: '2026-01-01T00:00:00.000Z',
});

const hyderabad = place('hyd', 'Hyderabad', 'Asia/Kolkata', 17.385, 78.4867);
const warangal = place('wgl', 'Warangal', 'Asia/Kolkata', 17.9689, 79.5941);
const london = place('lon', 'London', 'Europe/London', 51.5074, -0.1278);
const paris = place('par', 'Paris', 'Europe/Paris', 48.8566, 2.3522);
const newYork = place('nyc', 'New York', 'America/New_York', 40.7128, -74.006);
const boston = place('bos', 'Boston', 'America/New_York', 42.3601, -71.0589);

/** A routing source with a fixed answer, recording what it was asked. */
function routing(durationMinutes: number) {
  const calls: RouteRequest[] = [];
  const provider: RoutingProvider = {
    descriptor: {
      id: 'fixed-routing',
      label: 'Fixed routing',
      kinds: ['routing'],
      requiredEnv: [],
      coverage: 'global',
      docsUrl: null,
      attribution: null,
    },
    isConfigured: () => true,
    health: async () => ok({ ok: true as const, latencyMs: 0 }, provenance()),
    route: async (req) => {
      calls.push(req);
      return ok({ distanceKm: 150, durationMinutes, geometry: null }, provenance());
    },
  };
  return { provider, calls };
}

function provenance() {
  return {
    provider: 'fixed-routing',
    providerLabel: 'Fixed routing',
    retrievedAt: '2026-01-01T00:00:00.000Z',
    validUntil: null,
    searchId: null,
    attribution: null,
  };
}

async function drive(
  from: Place,
  to: Place,
  date: string,
  departLocalTime: string,
  durationMinutes: number,
): Promise<{ offer: TransportOffer; departAt: string | undefined }> {
  const { provider, calls } = routing(durationMinutes);
  const res = await new SelfDriveProvider(provider, null).estimate({
    origin: from,
    destination: to,
    date,
    departLocalTime,
    currency: 'INR',
  });
  if (res.status !== 'ok') throw new Error(res.message);
  return { offer: res.data, departAt: calls[0]?.departAt };
}

const originalTz = process.env['TZ'];
afterEach(() => {
  if (originalTz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = originalTz;
});

describe('self-drive times', () => {
  it('uses the origin zone for departure and the destination zone for arrival (India)', async () => {
    const { offer, departAt } = await drive(hyderabad, warangal, '2026-11-10', '08:00', 120);
    const seg = offer.segments[0]!;

    expect(seg.departureAt).toBe('2026-11-10T08:00:00+05:30');
    expect(seg.arrivalAt).toBe('2026-11-10T10:00:00+05:30');
    // The routing source is asked about the real instant, for traffic.
    expect(departAt).toBe('2026-11-10T02:30:00.000Z');
    expect(offer.overnight).toBe(false);
  });

  it('handles a zone at UTC', async () => {
    const { offer } = await drive(london, london, '2026-11-10', '09:00', 60);
    expect(offer.segments[0]!.departureAt).toBe('2026-11-10T09:00:00+00:00');
    expect(offer.segments[0]!.arrivalAt).toBe('2026-11-10T10:00:00+00:00');
  });

  it('reports the arrival in local time when the drive crosses into another zone', async () => {
    // Two hours from London at 08:00 GMT is 10:00 GMT, which is 11:00 in
    // Paris. (Two hours needs no rest stop, so only the zone changes.)
    const { offer } = await drive(london, paris, '2026-11-10', '08:00', 120);
    expect(offer.segments[0]!.arrivalAt).toBe('2026-11-10T11:00:00+01:00');
  });

  it('survives the daylight-saving jump', async () => {
    // New York clocks go from 02:00 to 03:00 on 8 March 2026. An hour's drive
    // from 01:30 EST ends at 03:30 EDT, not 02:30.
    const { offer } = await drive(newYork, boston, '2026-03-08', '01:30', 60);
    expect(offer.segments[0]!.departureAt).toBe('2026-03-08T01:30:00-05:00');
    expect(offer.segments[0]!.arrivalAt).toBe('2026-03-08T03:30:00-04:00');
  });

  it('marks a drive that ends on a later local date as overnight', async () => {
    // 22:00 plus 3 hours of driving and one 30-minute rest stop.
    const { offer } = await drive(hyderabad, warangal, '2026-11-10', '22:00', 180);
    expect(offer.segments[0]!.arrivalAt).toBe('2026-11-11T01:30:00+05:30');
    expect(offer.overnight).toBe(true);
  });

  it.each(['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Kolkata'])(
    'gives the same answer when the server runs in %s',
    async (serverZone) => {
      process.env['TZ'] = serverZone;
      const { offer, departAt } = await drive(hyderabad, warangal, '2026-11-10', '08:00', 120);
      expect(offer.segments[0]!.departureAt).toBe('2026-11-10T08:00:00+05:30');
      expect(offer.segments[0]!.arrivalAt).toBe('2026-11-10T10:00:00+05:30');
      expect(departAt).toBe('2026-11-10T02:30:00.000Z');
    },
  );

  it('refuses a departure time that is not a time of day', async () => {
    const { provider } = routing(60);
    const res = await new SelfDriveProvider(provider, null).estimate({
      origin: hyderabad,
      destination: warangal,
      date: '2026-11-10',
      departLocalTime: '25:99x',
      currency: 'INR',
    });
    expect(res.status).toBe('invalid_request');
  });

  it('still rejects a malformed time given in words', async () => {
    const { provider } = routing(60);
    const res = await new SelfDriveProvider(provider, null).estimate({
      origin: hyderabad,
      destination: warangal,
      date: '2026-11-10',
      departLocalTime: '8am',
      currency: 'INR',
    });
    expect(res.status).toBe('invalid_request');
  });
});

describe('self-drive cost', () => {
  const profile = {
    currency: 'INR',
    consumptionPer100Km: 7.5,
    energyPrice: 105,
    perKmAllowance: 1.5,
    maxDrivingHoursBeforeBreak: 3,
    breakMinutes: 30,
    averageOccupancy: 2,
  };

  const estimate = async (withProfile: boolean) => {
    const { provider } = routing(120);
    const res = await new SelfDriveProvider(provider, withProfile ? profile : null).estimate({
      origin: hyderabad,
      destination: warangal,
      date: '2026-11-10',
      departLocalTime: '08:00',
      currency: 'INR',
    });
    if (res.status !== 'ok') throw new Error(res.message);
    return res;
  };

  it('has a known fare of ₹0, because nobody sells a ticket for your own car', async () => {
    const { data } = await estimate(false);
    expect(data.totalPrice).toEqual({ amount: 0, currency: 'INR' });
    expect(data.pricePerTraveler).toEqual({ amount: 0, currency: 'INR' });
  });

  it('names fuel, wear, tolls and parking as not calculated when there is no vehicle profile', async () => {
    const { data, warnings } = await estimate(false);
    expect(data.itemisedFees).toEqual([]);
    expect(data.unpricedCosts).toEqual(['Fuel', 'Wear and tear', 'Tolls', 'Parking']);
    expect(warnings.join(' ')).toMatch(/Fuel and wear are not calculated/);
  });

  it('shows fuel and wear separately, as labelled estimates, when they can be calculated', async () => {
    const { data } = await estimate(true);

    // 150 km at 7.5 per 100 km and ₹105 per litre is ₹1,181.25; wear at ₹1.50 per km is ₹225.
    expect(data.totalPrice.amount).toBe(0);
    expect(data.itemisedFees).toEqual([
      expect.objectContaining({ label: 'Fuel', amount: { amount: 118125, currency: 'INR' }, included: false, isEstimate: true }),
      expect.objectContaining({ label: 'Wear and tear', amount: { amount: 22500, currency: 'INR' }, included: false, isEstimate: true }),
    ]);
    expect(data.itemisedFees[0]!.basis).toMatch(/vehicle profile over 150 km/);
    // Tolls and parking still have no source, whatever the profile says.
    expect(data.unpricedCosts).toEqual(['Tolls', 'Parking']);
  });
});
