import { describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@trip/providers';
import { money, ok, type HotelOffer, type Priority, type TransportOffer } from '@trip/shared';
import { generatePlans } from '../plans.js';
import { buildConstraintsOnly, hotel, intent, profile, transportOffer } from './fixtures.js';

/**
 * Plan ranking against the traveller's priorities. Each plan's journey is
 * scored against every outbound option found. Scoring a plan's journey on its
 * own normalised every dimension against a set of one, so price, speed and
 * changes all came out as 1 and every plan tied.
 */

const base = transportOffer();
const cheapSlow = transportOffer({
  id: 'cheap-slow',
  totalPrice: money(3000, 'INR'),
  totalDurationMinutes: 240,
  transfers: 1,
  segments: [{ ...base.segments[0]!, departureAt: '2026-11-10T08:00:00', arrivalAt: '2026-11-10T12:00:00', durationMinutes: 240 }],
});
const dearFast = transportOffer({
  id: 'dear-fast',
  totalPrice: money(9000, 'INR'),
  totalDurationMinutes: 75,
  transfers: 0,
});

function registry(flights: TransportOffer[], hotels: HotelOffer[] = []): ProviderRegistry {
  return {
    flights: [{ searchFlights: async () => ok(flights, flights[0]!.provenance) }],
    railFor: () => [],
    busesFor: () => [],
    selfDrive: null,
    amadeus: null,
    activities: [],
    groundTransport: [],
    taxiTariffs: {},
    hotels: hotels.length ? [{ searchHotels: async () => ok(hotels, hotels[0]!.provenance) }] : [],
    missingCapabilityNote: (capability: string) => ({
      status: 'not_configured' as const,
      provider: 'none',
      providerLabel: capability,
      message: `${capability} is not configured.`,
      occurredAt: '2026-01-01T00:00:00.000Z',
    }),
  } as unknown as ProviderRegistry;
}

const planFor = async (priorities: Priority[]) => {
  const p = profile({ priorities });
  return generatePlans({
    registry: registry([cheapSlow, dearFast]),
    intent: intent({ returnDate: null }),
    profile: p,
    constraints: buildConstraintsOnly(p),
  });
};

describe('ranking plans against the traveller’s priorities', () => {
  it('ranks the cheaper journey first when cost matters most', async () => {
    const { plans } = await planFor(['cheapest']);
    const byJourney = Object.fromEntries(plans.map((p) => [p.outboundTransport!.id, p.priorityScore]));

    expect(byJourney['cheap-slow']).toBe(1);
    expect(byJourney['dear-fast']).toBe(0);
    expect(plans[0]!.outboundTransport!.id).toBe('cheap-slow');
  });

  it('ranks the faster journey first when speed matters most', async () => {
    const { plans } = await planFor(['fastest']);
    expect(plans[0]!.outboundTransport!.id).toBe('dear-fast');
    expect(plans[0]!.priorityScore).toBeGreaterThan(plans[1]!.priorityScore);
  });

  it('keeps the existing weighting: later priorities still count, just less', async () => {
    // Cost first, speed second: the dear, fast option gains from speed but
    // cannot overtake the cheap one, whose cost weight is larger.
    const { plans } = await planFor(['cheapest', 'fastest']);
    const byJourney = Object.fromEntries(plans.map((p) => [p.outboundTransport!.id, p.priorityScore]));
    expect(byJourney['cheap-slow']).toBeGreaterThan(byJourney['dear-fast']!);
    expect(byJourney['dear-fast']).toBeGreaterThan(0);
  });
});

describe('calling a plan the most expensive', () => {
  it('only says so of the plan that really is', async () => {
    // One flight, so plans differ only by hotel. Comfort takes the 5-star;
    // balanced takes the property at the centre of town, which costs most.
    const room = hotel().rooms[0]!;
    const priced = (id: string, category: number, rupees: number, lat: number) =>
      hotel({
        id,
        category,
        coordinates: { lat, lon: 77.5946 },
        rooms: [{ ...room, totalPrice: money(rupees, 'INR'), pricePerNight: money(rupees / 4, 'INR') }],
      });
    const hotels = [
      priced('h-cheap', 2, 8_000, 12.99),
      priced('h-five-star', 5, 30_000, 13.02),
      priced('h-central', 4, 50_000, 12.9716),
    ];
    const p = profile({ priorities: ['fewest_transfers'] });
    const { plans } = await generatePlans({
      registry: registry([dearFast], hotels),
      intent: intent(),
      profile: p,
      constraints: buildConstraintsOnly(p),
    });

    const byArchetype = Object.fromEntries(plans.map((plan) => [plan.archetype, plan]));
    expect(byArchetype['comfort']?.hotels[0]?.hotel.id).toBe('h-five-star');
    expect(byArchetype['comfort']?.tradeoffs).not.toContain('This is the most expensive of the alternatives.');
    expect(byArchetype['balanced']?.hotels[0]?.hotel.id).toBe('h-central');
    expect(byArchetype['balanced']?.tradeoffs).toContain('This is the most expensive of the alternatives.');
  });
});
