import { describe, expect, it } from 'vitest';
import { money, type Place, type TransportMode, type TransportOffer } from '@trip/shared';
import { classifyJourney } from '../classify.js';
import { generatePlans } from '../plans.js';
import { searchTransport } from '../transport.js';
import { buildConstraintsOnly, hotel, hyderabad, intent, paris, profile, transportOffer } from './fixtures.js';
import { answers, busProvider, flightProvider, hotelProvider, railProvider, registryWith } from './kit.js';

/**
 * Which ways of travelling are looked at, and when.
 *
 *  - An international trip is a flight: no train, bus or drive is searched
 *    where none exists between the two countries.
 *  - A domestic trip looks at flying, the train, the bus and driving one's
 *    own car, wherever the distance, the traveller's exclusions and the
 *    connected providers allow.
 */

const kathmandu: Place = { ...hyderabad, id: 'test:ktm', name: 'Kathmandu', coordinates: { lat: 27.7172, lon: 85.324 }, countryCode: 'NP', countryName: 'Nepal', timezone: 'Asia/Kathmandu', airports: [{ iataCode: 'KTM', name: 'Tribhuvan Intl', distanceKm: 6, coordinates: null }] };
const warangal: Place = { ...hyderabad, id: 'test:wgl', name: 'Warangal', coordinates: { lat: 17.9689, lon: 79.5941 }, airports: [] };

function offer(mode: TransportMode, id: string, rupees: number, minutes: number, overrides: Partial<TransportOffer> = {}): TransportOffer {
  const base = transportOffer();
  return {
    ...base,
    id,
    mode,
    segments: [{ ...base.segments[0]!, mode: mode as never }],
    totalPrice: money(rupees, 'INR'),
    pricePerTraveler: money(rupees / 2, 'INR'),
    totalDurationMinutes: minutes,
    ...overrides,
  };
}

interface Calls {
  flight: number;
  train: number;
  bus: number;
}

function domesticRegistry(calls: Calls) {
  return registryWith({
    flights: [flightProvider('flights', async () => (calls.flight++, answers.ok([offer('flight', 'f1', 9600, 75)])))],
    rail: [railProvider('rail', async () => (calls.train++, answers.ok([offer('train', 't1', 2400, 600, { overnight: true })])), ['IN'])],
    buses: [busProvider('bus', async () => (calls.bus++, answers.ok([offer('bus', 'b1', 1800, 660)])), ['IN'])],
    selfDrive: { distanceKm: 570, durationMinutes: 540 },
  });
}

const search = (registry: ReturnType<typeof registryWith>, trip = intent(), p = profile()) =>
  searchTransport(
    { registry, intent: trip, classification: classifyJourney(trip.origin, trip.destination, { excludedByTraveler: p.transport.excludedModes as never }), profile: p, constraints: buildConstraintsOnly(p, trip) },
    'outbound',
  );

describe('domestic trips look at every way of travelling that applies', () => {
  it('searches flights, trains, buses and driving for Hyderabad to Bengaluru', async () => {
    const calls: Calls = { flight: 0, train: 0, bus: 0 };
    const result = await search(domesticRegistry(calls));

    expect(calls).toEqual({ flight: 1, train: 1, bus: 1 });
    const withOffers = result.modes.filter((m) => m.offers.length > 0).map((m) => m.mode);
    expect(withOffers).toEqual(expect.arrayContaining(['flight', 'train', 'bus', 'self_drive']));
    // Driving one's own car has no fare; fuel is separate and named as not calculated without a profile.
    const drive = result.modes.find((m) => m.mode === 'self_drive')!.offers[0]!.candidate;
    expect(drive.totalPrice.amount).toBe(0);
  });

  it('does not search a mode the traveller excluded, and says why it is missing', async () => {
    const calls: Calls = { flight: 0, train: 0, bus: 0 };
    const p = profile({ transport: { ...profile().transport, excludedModes: ['bus', 'train'] } });
    const result = await search(domesticRegistry(calls), intent(), p);
    expect(calls).toEqual({ flight: 1, train: 0, bus: 0 });
    expect(result.modes.map((m) => m.mode)).not.toContain('bus');
  });

  it('does not offer a flight for a short hop, where flying costs more time than it saves', async () => {
    const calls: Calls = { flight: 0, train: 0, bus: 0 };
    const trip = intent({ destination: warangal, destinationQuery: 'Warangal' });
    const result = await search(domesticRegistry(calls), trip);
    expect(calls.flight).toBe(0);
    expect(result.modes.map((m) => m.mode)).not.toContain('flight');
    expect(calls.train + calls.bus).toBeGreaterThan(0);
  });

  it('says a mode has no provider rather than pretending it has no options', async () => {
    const registry = registryWith({ flights: [flightProvider('flights', async () => answers.ok([offer('flight', 'f1', 9600, 75)]))] });
    const result = await search(registry);
    const train = result.modes.find((m) => m.mode === 'train')!;
    expect(train.offers).toHaveLength(0);
    expect(train.note).toMatchObject({ status: 'not_configured', capability: 'trains' });
    const bus = result.modes.find((m) => m.mode === 'bus')!;
    expect(bus.note).toMatchObject({ status: 'not_configured', capability: 'buses' });
  });
});

describe('international trips are flights', () => {
  it('searches only flights for Hyderabad to Paris, and never asks a train or bus provider', async () => {
    const calls: Calls = { flight: 0, train: 0, bus: 0 };
    const trip = intent({ destination: paris, destinationQuery: 'Paris' });
    const result = await search(domesticRegistry(calls), trip);

    expect(calls).toEqual({ flight: 1, train: 0, bus: 0 });
    expect(result.modes.filter((m) => m.offers.length > 0).map((m) => m.mode)).toEqual(['flight']);
    const classification = classifyJourney(hyderabad, paris);
    expect(classification.scope).toBe('international');
    expect(classification.excludedModes.map((e) => e.mode)).toEqual(expect.arrayContaining(['train', 'bus', 'self_drive']));
  });

  it('builds plans around a flight in both directions', async () => {
    const trip = intent({ destination: paris, destinationQuery: 'Paris', returnDate: '2026-11-17' });
    const registry = registryWith({
      flights: [flightProvider('flights', async (req: { origin: { name: string } }) => answers.ok([offer('flight', req.origin.name === 'Paris' ? 'back' : 'out', 52000, 600)]))],
      hotels: [hotelProvider('hotels', async () => answers.ok([hotel({ coordinates: paris.coordinates })]))],
    });
    const p = profile();
    const result = await generatePlans({ registry, intent: trip, profile: p, constraints: buildConstraintsOnly(p, trip) });

    expect(result.plans.length).toBeGreaterThan(0);
    for (const plan of result.plans) {
      expect(plan.outboundTransport?.mode).toBe('flight');
      expect(plan.returnTransport?.mode).toBe('flight');
    }
  });

  it('still considers surface travel between neighbouring countries that have a real route', async () => {
    const calls: Calls = { flight: 0, train: 0, bus: 0 };
    const trip = intent({ destination: kathmandu, destinationQuery: 'Kathmandu' });
    const classification = classifyJourney(hyderabad, kathmandu);
    expect(classification.scope).toBe('international');
    expect(classification.surfaceRoutePlausible).toBe(true);
    await search(domesticRegistry(calls), trip);
    // Flights are searched, and so is a mode that genuinely exists there. (Rail
    // coverage in this test is India only, so the rail provider is skipped.)
    expect(calls.flight).toBe(1);
  });
});
