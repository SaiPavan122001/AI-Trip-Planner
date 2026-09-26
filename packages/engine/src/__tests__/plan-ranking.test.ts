import { describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@trip/providers';
import { money, ok, type HotelOffer, type Priority, type TransportOffer } from '@trip/shared';
import { buildConstraints } from '../constraints.js';
import { budgetOvershootFactor } from '../plan-score.js';
import { generatePlans } from '../plans.js';
import { hotel, intent, profile, transportOffer } from './fixtures.js';

/**
 * Two traveller-facing rules:
 *  - A budget is a guide unless the traveller says "do not exceed": over-budget
 *    plans are shown, flagged and ranked lower, and nothing is filtered.
 *  - The stay counts in ranking as much as the journey.
 */

/** A flight on the given date, so the outbound and return legs do not overlap. */
const flight = (id: string, rupees: number, date = '2026-11-10', hour = '10'): TransportOffer =>
  transportOffer({
    id,
    totalPrice: money(rupees, 'INR'),
    segments: [
      { ...transportOffer().segments[0]!, departureAt: `${date}T${hour}:00:00`, arrivalAt: `${date}T${Number(hour) + 1}:15:00` },
    ],
  });

function registry(flights: TransportOffer[], hotels: HotelOffer[]): ProviderRegistry {
  return {
    flights: [
      {
        // Each direction gets a flight on its own date.
        searchFlights: async (req: { departureDate: string }) => {
          const hour = req.departureDate === '2026-11-14' ? '16' : '10';
          const offers = flights.map((f) => flight(f.id, f.totalPrice.amount / 100, req.departureDate, hour));
          return ok(offers, offers[0]!.provenance);
        },
      },
    ],
    railFor: () => [],
    busesFor: () => [],
    selfDrive: null,
    amadeus: null,
    activities: [],
    groundTransport: [],
    taxiTariffs: {},
    hotels: [{ searchHotels: async () => ok(hotels, hotels[0]!.provenance) }],
    missingCapabilityNote: (capability: string) => ({
      status: 'not_configured' as const,
      provider: 'none',
      providerLabel: capability,
      message: `${capability} is not configured.`,
      occurredAt: '2026-01-01T00:00:00.000Z',
    }),
  } as unknown as ProviderRegistry;
}

const room = hotel().rooms[0]!;
const stay = (id: string, category: number, rupees: number, lat: number): HotelOffer =>
  hotel({
    id,
    category,
    coordinates: { lat, lon: 77.5946 },
    rooms: [{ ...room, totalPrice: money(rupees, 'INR'), pricePerNight: money(rupees / 4, 'INR') }],
  });

const HOTELS = [
  stay('h-simple', 2, 8_000, 12.99),
  stay('h-luxury', 5, 60_000, 13.02),
  stay('h-mid', 4, 24_000, 12.9716),
];

const search = (priorities: Priority[], budget: { total: number; firm: boolean } | null) => {
  const p = profile({ priorities });
  const tripIntent = intent();
  const constraints = buildConstraints(tripIntent, p, {
    total: budget ? money(budget.total, 'INR') : null,
    transport: null,
    accommodation: null,
    dailySpendPerPerson: null,
    firm: budget?.firm ?? false,
  });
  return generatePlans({
    registry: registry([flight('f-1', 9_000)], HOTELS),
    intent: tripIntent,
    profile: p,
    constraints,
  });
};

describe('the stay counts in ranking', () => {
  it('puts the plan with the luxurious stay first when comfort matters most', async () => {
    const { plans } = await search(['most_comfortable'], null);
    expect(plans[0]!.hotels[0]!.hotel.id).toBe('h-luxury');
  });

  it('puts the plan with the simple, cheap stay first when cost matters most', async () => {
    const { plans } = await search(['cheapest'], null);
    expect(plans[0]!.hotels[0]!.hotel.id).toBe('h-simple');
  });

  it('shows how the journey and the stay each contributed', async () => {
    const { plans } = await search(['cheapest'], null);
    const keys = Object.keys(plans[0]!.scoreBreakdown);
    expect(keys.some((k) => k.startsWith('journey.'))).toBe(true);
    expect(keys.some((k) => k.startsWith('stay.'))).toBe(true);
  });
});

describe('a budget is a guide unless the traveller says it is firm', () => {
  it('still shows plans above a guide budget, flagged and ranked lower', async () => {
    // ₹30,000 is well below the luxury plan and the mid plan.
    const { plans } = await search(['most_comfortable'], { total: 30_000, firm: false });

    const luxury = plans.find((p) => p.hotels[0]!.hotel.id === 'h-luxury');
    expect(luxury).toBeDefined();
    const flagged = luxury!.issues.find((i) => i.code === 'over_budget_guide');
    expect(flagged?.severity).toBe('warning');
    expect(luxury!.issues.map((i) => i.code)).not.toContain('budget_exceeded');
    // Comfort would put the luxury plan first; being far over the guide lowers it.
    expect(luxury!.scoreBreakdown['over_budget_guide']).toBeLessThan(0);
    expect(plans[0]!.hotels[0]!.hotel.id).not.toBe('h-luxury');
  });

  it('filters nothing out for being dear when the budget is a guide', async () => {
    const { transport, hotels } = await search(['cheapest'], { total: 1_000, firm: false });
    expect(transport.outbound.filtered).toEqual([]);
    expect(hotels.filtered).toEqual([]);
  });

  it('blocks plans that break a firm budget, and filters what cannot fit on its own', async () => {
    const { plans, transport, hotels } = await search(['most_comfortable'], { total: 40_000, firm: true });

    // The ₹60,000 stay cannot fit ₹40,000 even alone.
    expect(hotels.filtered.map((f) => f.hotelId)).toContain('h-luxury');
    expect(hotels.filtered.find((f) => f.hotelId === 'h-luxury')!.reason).toMatch(/firm budget/);
    expect(transport.outbound.filtered).toEqual([]);
    for (const p of plans) expect(p.issues.map((i) => i.code)).not.toContain('over_budget_guide');
  });

  it('never ranks a plan that cannot be carried out above one that can', async () => {
    // ₹35,000 firm: the simple stay fits, the mid-range one does not.
    const { plans } = await search(['most_comfortable'], { total: 35_000, firm: true });
    const blocked = plans.map((p) => p.issues.some((i) => i.severity === 'blocker'));
    // Both kinds are present, and every plan that can be carried out comes first.
    expect(blocked).toContain(true);
    expect(blocked).toContain(false);
    expect([...blocked].sort()).toEqual(blocked);
  });
});

describe('the overshoot factor', () => {
  const total = (rupees: number) => money(rupees, 'INR');
  const budget = money(100_000, 'INR');

  it('leaves a plan within its budget untouched', () => {
    expect(budgetOvershootFactor(total(90_000), budget, false)).toBe(1);
    expect(budgetOvershootFactor(total(100_000), budget, false)).toBe(1);
  });

  it('scales a plan down in proportion to how far over it goes', () => {
    expect(budgetOvershootFactor(total(110_000), budget, false)).toBeCloseTo(0.9, 5);
    expect(budgetOvershootFactor(total(150_000), budget, false)).toBeCloseTo(0.5, 5);
  });

  it('never goes below the floor, so a plan that is worth it can still win', () => {
    expect(budgetOvershootFactor(total(500_000), budget, false)).toBe(0.3);
  });

  it('does nothing for a firm budget, which filters and blocks instead, or with no budget', () => {
    expect(budgetOvershootFactor(total(500_000), budget, true)).toBe(1);
    expect(budgetOvershootFactor(total(500_000), null, false)).toBe(1);
  });
});
