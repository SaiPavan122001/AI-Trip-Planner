import { describe, expect, it } from 'vitest';
import { money, type ActivityOffer, type ItineraryItem, type TransportOffer, type TripPlan } from '@trip/shared';
import { generatePlans } from '../plans.js';
import { buildConstraintsOnly, hotel, intent, profile, transportOffer } from './fixtures.js';
import { activityProvider, answers, flightProvider, hotelProvider, provenance, registryWith } from './kit.js';

/**
 * Can the itinerary actually be lived? Nothing may overlap, travel takes the
 * time it takes, places are only visited while open, meals are not skipped
 * over, and a hotel check-out cannot come after the journey home has left.
 */

const two = (n: number) => String(n).padStart(2, '0');

function flight(id: string, date: string, from: string, to: string, depHour: number, depMinute = 0, minutes = 75): TransportOffer {
  const base = transportOffer();
  const dep = new Date(Date.UTC(2000, 0, 1, depHour, depMinute));
  const arr = new Date(dep.getTime() + minutes * 60_000);
  const at = (d: Date) => `${date}T${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:00`;
  return {
    ...base,
    id,
    totalPrice: money(9600, 'INR'),
    segments: [{ ...base.segments[0]!, origin: { ...base.segments[0]!.origin, code: from }, destination: { ...base.segments[0]!.destination, code: to }, departureAt: at(dep), arrivalAt: at(arr), durationMinutes: minutes }],
    totalDurationMinutes: minutes,
  };
}

const everyDay = (opens = '09:00', closes = '18:00') => [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens, closes }));

function place(id: string, lat: number, lon: number, over: Partial<ActivityOffer> = {}): ActivityOffer {
  return {
    id,
    name: `Place ${id}`,
    category: 'tourist_attraction',
    description: null,
    coordinates: { lat, lon },
    address: null,
    openingHours: everyDay(),
    typicalDurationMinutes: 120,
    price: null,
    priceIsEstimate: false,
    bookingRequired: null,
    rating: 4.5,
    ratingCount: 5000,
    accessibility: [],
    provenance: provenance('places'),
    ...over,
  };
}

/** Three places a few kilometres apart, so every hop between them takes real time. */
const SPREAD = [place('a', 12.9716, 77.5946), place('b', 13.0016, 77.6246), place('c', 12.9416, 77.6546)];

async function planFor(opts: { places?: ActivityOffer[]; returnDep?: [number, number]; out?: [number, number] } = {}) {
  const [oh, om] = opts.out ?? [8, 0];
  const [rh, rm] = opts.returnDep ?? [16, 0];
  const registry = registryWith({
    flights: [
      flightProvider('flights', async (req: { departureDate: string; origin: { name: string } }) =>
        answers.ok([
          req.origin.name === 'Bengaluru'
            ? flight('back', req.departureDate, 'BLR', 'HYD', rh, rm)
            : flight('out', req.departureDate, 'HYD', 'BLR', oh, om),
        ]),
      ),
    ],
    hotels: [hotelProvider('hotels', async () => answers.ok([hotel()]))],
    activities: [activityProvider('places', async () => answers.ok(opts.places ?? SPREAD))],
  });
  const p = profile();
  const result = await generatePlans({
    registry,
    intent: intent({ returnDate: '2026-11-14' }),
    profile: p,
    constraints: buildConstraintsOnly(p),
  });
  return result.plans;
}

const itemsOf = (plan: TripPlan): ItineraryItem[] =>
  plan.days
    .flatMap((d) => d.items)
    .filter((i) => i.kind !== 'rest')
    .sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));

const minutesBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60_000;

describe('a day of activities is something a person can do', () => {
  it('builds plans with things to do', async () => {
    const plans = await planFor();
    expect(plans.length).toBeGreaterThan(0);
    expect(plans[0]!.activities.length).toBeGreaterThan(0);
  });

  it('never has two things happening at once', async () => {
    for (const plan of await planFor()) {
      const items = itemsOf(plan);
      for (let i = 1; i < items.length; i += 1) {
        const gap = minutesBetween(items[i - 1]!.endUtc, items[i]!.startUtc);
        expect(gap, `"${items[i - 1]!.title}" then "${items[i]!.title}"`).toBeGreaterThanOrEqual(0);
      }
      expect(plan.issues.filter((i) => i.code === 'overlapping_items' || i.code === 'validation.overlap')).toEqual([]);
    }
  });

  it('starts each visit only after the journey to it has finished', async () => {
    for (const plan of await planFor()) {
      const items = itemsOf(plan);
      items.forEach((item, i) => {
        if (item.kind !== 'activity') return;
        const before = items[i - 1]!;
        if (before.kind === 'transfer') {
          expect(Date.parse(item.startUtc), `"${item.title}" begins before you have arrived`).toBeGreaterThanOrEqual(Date.parse(before.endUtc));
        }
      });
    }
  });

  it('only visits a place while it is open, for the whole visit', async () => {
    const early = place('early', 12.9716, 77.5946, { openingHours: everyDay('06:00', '10:30'), typicalDurationMinutes: 180 });
    for (const plan of await planFor({ places: [early] })) {
      for (const item of itemsOf(plan).filter((i) => i.kind === 'activity')) {
        const local = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3_600_000).toISOString().slice(11, 16);
        expect(local(item.endUtc) <= '10:30', `"${item.title}" runs past closing`).toBe(true);
      }
    }
  });

  it('leaves the time for lunch and dinner instead of running a visit through them', async () => {
    const long = SPREAD.map((p) => ({ ...p, typicalDurationMinutes: 240, openingHours: everyDay('09:00', '23:00') }));
    for (const plan of await planFor({ places: long })) {
      const items = itemsOf(plan);
      const meals = items.filter((i) => i.kind === 'meal');
      const activities = items.filter((i) => i.kind === 'activity');
      for (const meal of meals) {
        for (const a of activities) {
          const overlap = Date.parse(a.startUtc) < Date.parse(meal.endUtc) && Date.parse(meal.startUtc) < Date.parse(a.endUtc);
          expect(overlap, `"${a.title}" overlaps ${meal.title}`).toBe(false);
        }
      }
    }
  });
});

describe('leaving the hotel on the last day', () => {
  it('checks out before leaving for a morning flight, not after it has gone', async () => {
    const plans = await planFor({ returnDep: [6, 0] });
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      const items = itemsOf(plan);
      const checkout = items.find((i) => i.kind === 'check_out')!;
      const homeward = items.filter((i) => i.kind === 'transport').at(-1)!;
      expect(Date.parse(checkout.endUtc)).toBeLessThanOrEqual(Date.parse(homeward.startUtc));
      expect(plan.issues.filter((i) => i.severity === 'blocker')).toEqual([]);
    }
  });

  it('keeps the usual check-out time when there is no reason to leave earlier', async () => {
    const [plan] = await planFor({ returnDep: [20, 0] });
    const checkout = itemsOf(plan!).find((i) => i.kind === 'check_out')!;
    const local = new Date(Date.parse(checkout.startUtc) + 5.5 * 3_600_000).toISOString().slice(11, 16);
    expect(local).toBe('11:00');
  });
});
