import { describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@trip/providers';
import { money, ok, type ActivityOffer, type PlanningSession, type TransportOffer } from '@trip/shared';
import { buildConstraints } from '../constraints.js';
import { placeTypesFor, planActivities } from '../activities.js';
import { checkPins, componentsOf, selectedPlanOf } from '../pins.js';
import { generatePlans } from '../plans.js';
import { hotel, intent, profile, transportOffer } from './fixtures.js';

/**
 * Two small guarantees the planning agents rely on: pins are checked against the
 * trip the same way wherever they are used, and what steers the search for
 * things to do is a closed vocabulary that the engine, not a caller, turns into
 * provider place types.
 */

const flightOn = (date: string, hour: string): TransportOffer =>
  transportOffer({
    id: `f-${date}`,
    totalPrice: money(9_000, 'INR'),
    segments: [
      { ...transportOffer().segments[0]!, departureAt: `${date}T${hour}:00:00`, arrivalAt: `${date}T${Number(hour) + 1}:15:00` },
    ],
  });

function registry(activities: unknown[] = []): ProviderRegistry {
  return {
    flights: [
      {
        searchFlights: async (req: { departureDate: string }) => {
          const offer = flightOn(req.departureDate, req.departureDate === '2026-11-14' ? '16' : '10');
          return ok([offer], offer.provenance);
        },
      },
    ],
    railFor: () => [],
    busesFor: () => [],
    selfDrive: null,
    amadeus: null,
    activities,
    groundTransport: [],
    taxiTariffs: {},
    hotels: [{ searchHotels: async () => ok([hotel()], hotel().provenance) }],
    missingCapabilityNote: (capability: string) => ({
      status: 'not_configured' as const, provider: 'none', providerLabel: capability,
      message: `${capability} is not configured.`, occurredAt: '2026-01-01T00:00:00.000Z',
    }),
  } as unknown as ProviderRegistry;
}

async function aPlan() {
  const p = profile({ priorities: ['cheapest'] });
  const tripIntent = intent();
  const constraints = buildConstraints(tripIntent, p, { total: null, transport: null, accommodation: null, dailySpendPerPerson: null });
  const { plans } = await generatePlans({ registry: registry(), intent: tripIntent, profile: p, constraints });
  return { plan: plans[0]!, tripIntent };
}

const trip = (over: Partial<Pick<PlanningSession, 'intent' | 'plans' | 'selectedPlanId' | 'pins'>>) => ({
  intent: intent(), plans: [], selectedPlanId: null, pins: [], ...over,
});

describe('checking pins against a trip', () => {
  it('keeps pins that still fit', async () => {
    const { plan, tripIntent } = await aPlan();
    const check = checkPins(trip({ intent: tripIntent, plans: [plan], selectedPlanId: plan.id, pins: ['outbound', 'return', 'hotel'] }));
    expect(check.keep).toEqual(['outbound', 'return', 'hotel']);
    expect(check.released).toEqual([]);
  });

  it('releases what new dates make impossible, with the reason', async () => {
    const { plan } = await aPlan();
    const moved = intent({ departureDate: '2026-12-01', returnDate: '2026-12-05' });
    const check = checkPins(trip({ intent: moved, plans: [plan], selectedPlanId: plan.id, pins: ['outbound', 'return', 'hotel'] }));
    expect(check.keep).toEqual([]);
    expect(check.released.map((r) => r.component)).toEqual(['outbound', 'return', 'hotel']);
    for (const r of check.released) expect(r.reason).toMatch(/old dates/);
  });

  it('releases a hotel with more rooms than the group needs', async () => {
    const { plan } = await aPlan();
    plan.hotels[0]!.rooms = 5;
    const check = checkPins(trip({ plans: [plan], selectedPlanId: plan.id, pins: ['hotel'] }));
    expect(check.released[0]!.reason).toMatch(/more rooms than your group needs/);
  });

  it('always releases transfers, and anything when there is no plan', async () => {
    const { plan } = await aPlan();
    expect(checkPins(trip({ plans: [plan], selectedPlanId: plan.id, pins: ['transfers'] })).released[0]!.reason).toMatch(/recalculated/);
    expect(checkPins(trip({ pins: ['hotel'] })).released[0]!.reason).toMatch(/no plan to keep this from/);
  });

  it('knows what a plan has, and which plan is selected', async () => {
    const { plan } = await aPlan();
    expect(componentsOf(plan)).toEqual(expect.arrayContaining(['outbound', 'return', 'hotel']));
    expect(componentsOf(undefined)).toEqual([]);
    expect(selectedPlanOf({ plans: [plan], selectedPlanId: 'nope' })).toBe(plan);
    expect(selectedPlanOf({ plans: [], selectedPlanId: null })).toBeUndefined();
  });
});

describe('steering the search for things to do', () => {
  it('turns interests into provider place types, in code, from a closed list', () => {
    expect(placeTypesFor(['museums', 'beaches'])).toEqual(['museum', 'art_gallery', 'beach']);
    expect(placeTypesFor([])).toEqual([]);
    // A value outside the list has no place types: it cannot reach a provider.
    expect(placeTypesFor(['casino' as never])).toEqual([]);
  });

  const seen: Array<{ categories: string[]; limit: number }> = [];
  const provider = {
    searchActivities: async (req: { categories: string[]; limit: number }) => {
      seen.push({ categories: req.categories, limit: req.limit });
      const a = (id: string): ActivityOffer => ({
        id, name: id, category: 'museum', coordinates: { lat: 12.97, lon: 77.59 }, rating: 4.5, ratingCount: 900,
        price: null, priceIsEstimate: false, typicalDurationMinutes: 60, openingHours: null, accessibility: [],
        description: null, address: null,
        provenance: { provider: 'test', providerLabel: 'Test', retrievedAt: '2026-01-01T00:00:00.000Z', validUntil: null, searchId: null, attribution: null },
      } as unknown as ActivityOffer);
      return ok([a('a'), a('b'), a('c')], a('a').provenance);
    },
  };
  const destination = intent().destination;

  it('passes the interests as place types, and asks for a default set when there are none', async () => {
    seen.length = 0;
    await planActivities(registry([provider]), destination, profile(), 3, 'INR', undefined, { interests: ['museums'] });
    await planActivities(registry([provider]), destination, profile(), 3, 'INR');
    expect(seen[0]!.categories).toEqual(['museum', 'art_gallery']);
    expect(seen[1]!.categories).toEqual([]);
  });

  it('plans more or fewer things a day according to the pace', async () => {
    seen.length = 0;
    await planActivities(registry([provider]), destination, profile(), 4, 'INR', undefined, { pace: 'relaxed' });
    await planActivities(registry([provider]), destination, profile(), 4, 'INR', undefined, { pace: 'packed' });
    await planActivities(registry([provider]), destination, profile(), 4, 'INR');
    // limit = twice the target: 4 days at 1, 3 and (balanced) 2 a day, never fewer than 3 in all.
    expect(seen.map((s) => s.limit)).toEqual([8, 20, 16]);
  });

  it('is what generatePlans passes on', async () => {
    seen.length = 0;
    const p = profile({ priorities: ['cheapest'] });
    const tripIntent = intent();
    const constraints = buildConstraints(tripIntent, p, { total: null, transport: null, accommodation: null, dailySpendPerPerson: null });
    await generatePlans({
      registry: registry([provider]), intent: tripIntent, profile: p, constraints,
      activityGuidance: { interests: ['history'], pace: 'packed' },
    });
    expect(seen[0]!.categories).toEqual(['historical_landmark', 'tourist_attraction']);
  });
});
