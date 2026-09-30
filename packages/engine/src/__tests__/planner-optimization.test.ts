import { describe, expect, it } from 'vitest';
import { hasBlockers, money, type ItineraryItem } from '@trip/shared';
import { effectivePriorities, styleTargets } from '../optimize.js';
import { applyAnswer, QUESTION_KEYS } from '../questioner.js';
import { classifyJourney } from '../classify.js';
import { emptyTravelerProfile } from '@trip/shared';
import { intent, profile as makeProfile } from './fixtures.js';
import { DEFAULT_BACK, DEFAULT_OUT, journey, planOf, planTrip, property, room, surface, type JourneySpec } from './plan-kit.js';
import { answers, busProvider, flightProvider, hotelProvider, never, railProvider } from './kit.js';

/**
 * The planner builds a whole trip and chooses among real options for reasons
 * it can state. These tests hold it to that: it is not "the cheapest", the
 * traveller's style and requirements change what it picks, a firm budget is
 * kept when it can be and reported when it cannot, and a trip that cannot be
 * done says which requirement stands in the way.
 */

// A slow cheap journey with two changes, a middling one, and a fast direct one.
const CHEAP: JourneySpec = { id: 'cheap', rupees: 5_000, departs: 6 * 60, minutes: 300, transfers: 2 };
const MID: JourneySpec = { id: 'mid', rupees: 7_500, departs: 9 * 60, minutes: 150, transfers: 1 };
const FAST: JourneySpec = { id: 'fast', rupees: 12_000, departs: 8 * 60, minutes: 75, transfers: 0 };
const BACK: JourneySpec[] = [
  { id: 'back-cheap', rupees: 5_000, departs: 15 * 60, minutes: 300, transfers: 2 },
  { id: 'back-fast', rupees: 12_000, departs: 16 * 60, minutes: 75, transfers: 0 },
];

const idOf = (offerId: string | undefined) => (offerId ?? '').replace(/-2026-\d\d-\d\d$/, '');

describe('the planner does not simply take the cheapest', () => {
  it('offers different readings of best from the same options', async () => {
    const { plans } = await planTrip({ out: [CHEAP, MID, FAST], back: BACK, profile: { priorities: ['fastest'] } });
    expect(idOf(planOf(plans, 'budget')?.outboundTransport?.id)).toBe('cheap');
    expect(idOf(planOf(plans, 'balanced')?.outboundTransport?.id)).toBe('fast');
    // Comfort would take the same journey and the same stay as Balanced here, so it is not shown twice.
    expect(planOf(plans, 'comfort')).toBeUndefined();
  });

  it('weighs price when that is what the traveller said matters most', async () => {
    const { plans } = await planTrip({ out: [CHEAP, MID, FAST], back: BACK, profile: { priorities: ['cheapest'] } });
    expect(idOf(planOf(plans, 'budget')?.outboundTransport?.id)).toBe('cheap');
    // Balanced agrees with Budget here, so it is not shown twice; Comfort still means fewest changes, however much it costs.
    expect(planOf(plans, 'balanced')).toBeUndefined();
    expect(idOf(planOf(plans, 'comfort')?.outboundTransport?.id)).toBe('fast');
  });

  it('says what it chose and what it passed over, in each case', async () => {
    const { plans } = await planTrip({ out: [CHEAP, MID, FAST], back: BACK, profile: { priorities: ['cheapest'] } });
    const comfort = planOf(plans, 'comfort')!;
    const outward = comfort.choices.find((c) => c.topic === 'outbound')!;
    expect(outward.why).toMatch(/fewest changes and shortest time/);
    expect(outward.chosen).toMatch(/12,000/);
    // The alternatives are real offers, compared in money, time and changes.
    expect(outward.alternatives.length).toBeGreaterThan(0);
    expect(outward.alternatives.some((a) => /less/.test(a.note))).toBe(true);
    expect(comfort.choices.map((c) => c.topic)).toEqual(expect.arrayContaining(['outbound', 'return', 'stay', 'room']));
  });

  it('gives the same plans for the same inputs', async () => {
    const strip = (r: Awaited<ReturnType<typeof planTrip>>) =>
      JSON.parse(JSON.stringify(r.plans, (k, v) => (k === 'generatedAt' || k === 'occurredAt' || k === 'retrievedAt' ? undefined : v)));
    const spec = { out: [CHEAP, MID, FAST], back: BACK, profile: { priorities: ['fastest' as const] } };
    expect(strip(await planTrip(spec))).toEqual(strip(await planTrip(spec)));
  });
});

describe('a travel style changes what is chosen', () => {
  const STAYS = [
    property('simple', 2, [room('simple-std', 8_000)], 12.99),
    property('mid', 4, [room('mid-std', 24_000)], 12.9716),
    property('lux', 5, [room('lux-deluxe', 40_000), room('lux-suite', 90_000)], 12.98),
  ];

  it('picks the plainest stay for a budget trip and the best room in the best hotel for a luxury one', async () => {
    const budget = await planTrip({ stays: STAYS, profile: { travelStyle: 'budget' } });
    const luxury = await planTrip({ stays: STAYS, profile: { travelStyle: 'luxury' } });

    expect(planOf(budget.plans, 'budget')?.hotels[0]?.hotel.id).toBe('simple');
    // Balanced follows the style too: it is either the same plan as Budget (and not shown twice) or also the plain stay.
    expect(planOf(budget.plans, 'balanced')?.hotels[0]?.hotel.id ?? 'simple').toBe('simple');
    const lux = planOf(luxury.plans, 'balanced')!;
    expect(lux.hotels[0]!.hotel.id).toBe('lux');
    expect(lux.hotels[0]!.room.id).toBe('lux-suite');
    expect(lux.choices.find((c) => c.topic === 'room')!.why).toMatch(/top room/);
  });

  it('lets a premium style sit between the two', async () => {
    const { plans } = await planTrip({ stays: STAYS, profile: { travelStyle: 'premium' } });
    expect(planOf(plans, 'balanced')!.hotels[0]!.hotel.category).toBeGreaterThanOrEqual(4);
  });

  it('never lets a style override a rating the traveller asked for', async () => {
    const { plans } = await planTrip({
      stays: STAYS,
      profile: { travelStyle: 'budget', accommodation: { ...emptyTravelerProfile().accommodation, minCategory: 4 } },
    });
    for (const plan of plans) expect(plan.hotels[0]!.hotel.category).toBeGreaterThanOrEqual(4);
  });

  it('reads a style as a ranking only when the traveller ranked nothing', () => {
    expect(effectivePriorities(makeProfile({ travelStyle: 'luxury' }))).toEqual(['luxury', 'most_comfortable', 'fastest']);
    expect(effectivePriorities(makeProfile({ travelStyle: 'luxury', priorities: ['cheapest'] }))).toEqual(['cheapest']);
    expect(effectivePriorities(makeProfile())).toEqual([]);
    expect(styleTargets(makeProfile({ travelStyle: 'luxury' }))).toMatchObject({ targetCategory: 5, roomTier: 'highest' });
  });
});

describe('choosing the room', () => {
  it('takes the room that fits what was asked for, even when another is cheaper', async () => {
    const stays = [property('h', 3, [room('plain', 20_000), room('with-breakfast', 22_000, { breakfastIncluded: true })])];
    const { plans } = await planTrip({
      stays,
      profile: { accommodation: { ...emptyTravelerProfile().accommodation, breakfastIncluded: true } },
    });
    for (const plan of plans) expect(plan.hotels[0]!.room.id).toBe('with-breakfast');
    expect(planOf(plans, 'budget')!.choices.find((c) => c.topic === 'room')!.why).toMatch(/includes breakfast/);
  });

  it('takes a room that sleeps the whole party rather than dropping the hotel for its smaller one', async () => {
    const stays = [
      property('h', 3, [
        room('small', 10_000, { maxOccupancy: 2 }),
        room('family', 18_000, { maxOccupancy: 4 }),
      ]),
    ];
    const { plans, hotels } = await planTrip({ stays, intent: { travelers: { adults: 4, children: 0, infants: 0 } } });
    expect(hotels.filtered).toEqual([]);
    for (const plan of plans) expect(plan.hotels[0]!.room.id).toBe('family');
  });

  it('drops a property none of whose rooms sleep the party, and says how many they do sleep', async () => {
    const stays = [property('h', 3, [room('small', 10_000, { maxOccupancy: 2 })])];
    const { hotels } = await planTrip({ stays, intent: { travelers: { adults: 4, children: 0, infants: 0 } } });
    expect(hotels.candidates).toHaveLength(0);
    expect(hotels.filtered[0]!.reason).toMatch(/sleep 2 at most.*4 guest/);
  });

  it('keeps the top room inside the ceiling the traveller set for the stay', async () => {
    const stays = [property('h', 5, [room('r1', 30_000), room('r2', 60_000), room('r3', 90_000)])];
    const { plans } = await planTrip({
      stays,
      profile: { travelStyle: 'luxury' },
      budget: { accommodation: money(70_000, 'INR') },
    });
    expect(planOf(plans, 'balanced')!.hotels[0]!.room.id).toBe('r2');
    expect(planOf(plans, 'balanced')!.choices.find((c) => c.topic === 'room')!.why).toMatch(/what you set aside/);
  });

  it('counts every room booked against the stay budget, not just one', async () => {
    const stays = [property('h', 3, [room('r', 30_000)])];
    const { hotels } = await planTrip({
      stays,
      profile: { accommodation: { ...emptyTravelerProfile().accommodation, rooms: 2 } },
      intent: { travelers: { adults: 4, children: 0, infants: 0 } },
      budget: { accommodation: money(50_000, 'INR') },
    });
    // 2 rooms at 30,000 is 60,000, over a 50,000 stay budget; 1 room would not be.
    expect(hotels.candidates).toHaveLength(0);
    expect(hotels.filtered[0]!.reason).toMatch(/in 2 rooms/);
  });
});

describe('a firm budget', () => {
  const STAYS = [
    property('simple', 2, [room('simple-std', 8_000)], 12.99),
    property('lux', 5, [room('lux-deluxe', 40_000)], 12.98),
  ];
  const JOURNEYS: JourneySpec[] = [
    { id: 'cheap', rupees: 5_000, departs: 6 * 60, minutes: 300, transfers: 2 },
    { id: 'fast', rupees: 12_000, departs: 8 * 60, minutes: 75 },
  ];

  it('is kept, by taking the most preferred combination that fits, when one exists', async () => {
    // Fast flights (24,000) and the luxury stay (40,000) do not fit 45,000; cheaper combinations do.
    const total = money(45_000, 'INR');
    const { plans } = await planTrip({
      out: JOURNEYS,
      back: JOURNEYS.map((j) => ({ ...j, departs: j.departs + 8 * 60 })),
      stays: STAYS,
      budget: { total, firm: true },
    });
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      expect(plan.cost.total.amount, `${plan.label} costs ${plan.cost.total.amount}`).toBeLessThanOrEqual(total.amount);
      expect(plan.issues.filter((i) => i.severity === 'blocker')).toEqual([]);
    }
  });

  it('is reported with the numbers when nothing that exists can fit it', async () => {
    const { plans, feasibility } = await planTrip({
      out: JOURNEYS,
      back: JOURNEYS,
      stays: STAYS,
      budget: { total: money(10_000, 'INR'), firm: true },
    });
    const finding = feasibility.findings.find((f) => f.code === 'budget_below_cheapest_plan')!;
    expect(finding.severity).toBe('blocker');
    // 5,000 + 5,000 for the journeys and 8,000 for the room: 18,000 against 10,000.
    expect(finding.message).toMatch(/18,000/);
    expect(finding.message).toMatch(/10,000/);
    expect(finding.suggestions.join(' ')).toMatch(/Raise the budget to at least/);
    // The plans are still shown, marked as breaking the limit, not silently loosened.
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) expect(hasBlockers(plan)).toBe(true);
    expect(feasibility.status).toBe('partial');
  });

  it('says a guide budget is below the cheapest plan as a warning, not a blocker', async () => {
    const { feasibility } = await planTrip({
      out: JOURNEYS,
      back: JOURNEYS,
      stays: STAYS,
      budget: { total: money(10_000, 'INR'), firm: false },
    });
    expect(feasibility.findings.find((f) => f.code === 'budget_below_cheapest_plan')!.severity).toBe('warning');
  });

  it('does not touch the traveller’s hard limit when they agreed to go over it', async () => {
    const { plans } = await planTrip({
      out: JOURNEYS,
      back: JOURNEYS,
      stays: STAYS,
      budget: { total: money(10_000, 'INR'), firm: true },
    });
    expect(plans.every((p) => p.cost.total.amount > 1_000_000)).toBe(true);
  });
});

describe('safety', () => {
  const NIGHT: JourneySpec = { id: 'night', rupees: 4_000, departs: 22 * 60 + 30, minutes: 180 };
  const DAY: JourneySpec = { id: 'day', rupees: 8_000, departs: 8 * 60, minutes: 120 };

  it('leaves out an arrival in the small hours when asked, and says which option that removed', async () => {
    const withNight = await planTrip({
      out: [NIGHT, DAY],
      back: DEFAULT_BACK,
      profile: { transport: { ...emptyTravelerProfile().transport, avoidRedEyeArrival: true } },
    });
    const dropped = withNight.transport.outbound.filtered.find((f) => f.offerId.startsWith('night'));
    expect(dropped?.reason).toMatch(/01:30.*small hours/);
    for (const plan of withNight.plans) expect(idOf(plan.outboundTransport?.id)).toBe('day');
  });

  it('keeps that option when nothing was asked, so the requirement is what removed it', async () => {
    const free = await planTrip({ out: [NIGHT, DAY], back: DEFAULT_BACK });
    expect(free.transport.outbound.filtered).toEqual([]);
    expect(idOf(planOf(free.plans, 'budget')?.outboundTransport?.id)).toBe('night');
  });

  it('puts safety first in the ranking when asked, whatever else was ranked', () => {
    const p = makeProfile({ priorities: ['cheapest', 'fastest'], special: { ...emptyTravelerProfile().special, safetyFirst: true } });
    expect(effectivePriorities(p)).toEqual(['safest', 'cheapest', 'fastest']);
    const already = makeProfile({ priorities: ['fastest', 'safest'], special: { ...emptyTravelerProfile().special, safetyFirst: true } });
    expect(effectivePriorities(already)).toEqual(['safest', 'fastest']);
  });

  it('is asked about after travel style, and the answer changes the profile and nothing else', () => {
    expect(QUESTION_KEYS.indexOf('safety.preferences')).toBeGreaterThan(QUESTION_KEYS.indexOf('style.travel_style'));
    const ctx = { intent: intent(), classification: classifyJourney(intent().origin, intent().destination), profile: makeProfile() };
    const { profile: answered } = applyAnswer(ctx, { key: 'safety.preferences', value: ['safety_first', 'no_late_arrival'], skipped: false });
    expect(answered.special.safetyFirst).toBe(true);
    expect(answered.transport.avoidRedEyeArrival).toBe(true);
    expect(answered.priorities).toEqual([]);
    const { profile: skipped } = applyAnswer({ ...ctx, profile: answered }, { key: 'safety.preferences', value: null, skipped: true });
    expect(skipped.special.safetyFirst).toBe(false);
    expect(skipped.transport.avoidRedEyeArrival).toBe(false);
  });

  it('warns about a late arrival that is not ruled out, rather than hiding it', async () => {
    const { plans } = await planTrip({ out: [{ id: 'late', rupees: 4_000, departs: 21 * 60, minutes: 150 }] });
    expect(plans[0]!.issues.map((i) => i.code)).toContain('late_night_arrival');
  });
});

describe('the interview follows the order the trip is planned in', () => {
  it('asks about money, then style, then safety, then transport, then accommodation, then anything else', () => {
    const at = (k: string) => QUESTION_KEYS.indexOf(k);
    const order = ['budget.total', 'budget.firm', 'style.travel_style', 'safety.preferences', 'transport.cabin_class', 'accommodation.type', 'other.requirements'];
    order.forEach((k) => expect(at(k), k).toBeGreaterThanOrEqual(0));
    for (let i = 1; i < order.length; i += 1) expect(at(order[i]!), `${order[i]} after ${order[i - 1]}`).toBeGreaterThan(at(order[i - 1]!));
  });

  it('keeps "anything else" in the traveller’s own words, shows it on the plan, and does not claim it is met', async () => {
    const ctx = { intent: intent(), classification: classifyJourney(intent().origin, intent().destination), profile: makeProfile() };
    const { profile } = applyAnswer(ctx, { key: 'other.requirements', value: 'Please avoid the monsoon week', skipped: false });
    expect(profile.special.otherRequirements).toEqual(['Please avoid the monsoon week']);
    const { notes } = await planTrip({ profile: { special: profile.special } });
    const note = notes.find((n) => /You also asked for/.test(n.message))!;
    expect(note.message).toContain('Please avoid the monsoon week');
    expect(note.message).toMatch(/cannot check this/);
  });
});

describe('when the trip cannot be done as asked', () => {
  it('says the stay could not be found, not that it does not exist, when the provider is not connected', async () => {
    const { feasibility, plans } = await planTrip({ parts: { hotels: [] } });
    expect(feasibility.findings.map((f) => f.code)).toContain('stay_not_searched');
    expect(plans.length).toBeGreaterThan(0);
    expect(feasibility.status).toBe('partial');
  });

  it('says there is no stay when the provider answered and found none', async () => {
    const { feasibility } = await planTrip({ parts: { hotels: [hotelProvider('hotels', async () => answers.empty('hotels'))] } });
    expect(feasibility.findings.map((f) => f.code)).toContain('no_stay_found');
  });

  it('says the stay search failed, not that nothing exists, when the provider broke', async () => {
    const { feasibility } = await planTrip({ parts: { hotels: [hotelProvider('hotels', async () => answers.down('hotels'))] } });
    expect(feasibility.findings.find((f) => f.code === 'stay_search_failed')!.message).toMatch(/could not be searched properly/);
  });

  it('names the requirement that ruled out every journey', async () => {
    const { feasibility } = await planTrip({
      out: [MID, CHEAP],
      profile: { transport: { ...emptyTravelerProfile().transport, maxStops: 0 } },
    });
    const finding = feasibility.findings.find((f) => f.code === 'outward_excluded_by_requirements')!;
    expect(finding.severity).toBe('blocker');
    expect(finding.message).toMatch(/at most 0/);
  });

  it('says no journey was found, and that a source that broke may be hiding one', async () => {
    const none = await planTrip({ parts: { flights: [flightProvider('flights', async () => answers.empty('flights'))] } });
    expect(none.feasibility.findings.map((f) => f.code)).toContain('outward_none_found');
    const broken = await planTrip({ parts: { flights: [flightProvider('flights', async () => answers.down('flights'))] } });
    expect(broken.feasibility.findings.map((f) => f.code)).toContain('outward_providers_failed');
  });

  it('reports a trip with nothing to plan from as impossible, not as an empty success', async () => {
    const result = await planTrip({ parts: { flights: [], hotels: [] } });
    expect(result.plans).toHaveLength(0);
    expect(result.feasibility.status).toBe('infeasible');
    expect(result.feasibility.findings.some((f) => f.severity === 'blocker')).toBe(true);
  });

  it('is feasible, with nothing to report, when everything works', async () => {
    const { feasibility } = await planTrip({ out: DEFAULT_OUT, back: DEFAULT_BACK });
    expect(feasibility.status).toBe('feasible');
    expect(feasibility.findings.filter((f) => f.severity !== 'info')).toEqual([]);
  });
});

describe('a group', () => {
  it('is warned when rooms may not sleep everyone and the provider does not say', async () => {
    const { feasibility } = await planTrip({
      intent: { travelers: { adults: 5, children: 0, infants: 0 } },
      stays: [property('h', 3, [room('r', 20_000, { maxOccupancy: null })])],
    });
    expect(feasibility.findings.map((f) => f.code)).toContain('rooms_may_be_short');
  });

  it('is not warned when the rooms are known to sleep them', async () => {
    const { feasibility } = await planTrip({
      intent: { travelers: { adults: 4, children: 0, infants: 0 } },
      stays: [property('h', 3, [room('r', 20_000, { maxOccupancy: 4 })])],
    });
    expect(feasibility.findings.map((f) => f.code)).not.toContain('rooms_may_be_short');
  });
});

describe('changing a plan keeps what the traveller kept', () => {
  it('uses the kept hotel and journey exactly, marks them as kept, and searches the rest', async () => {
    const first = await planTrip({ out: [CHEAP, FAST], back: BACK, stays: [property('mine', 3, [room('mine-r', 20_000)])] });
    const plan = first.plans[0]!;
    const second = await planTrip({
      out: [MID],
      back: BACK,
      stays: [property('other', 5, [room('other-r', 60_000)])],
      keep: { outbound: plan.outboundTransport, hotel: plan.hotels[0] ?? null },
    });
    for (const p of second.plans) {
      expect(p.outboundTransport?.id).toBe(plan.outboundTransport!.id);
      expect(p.hotels[0]!.hotel.id).toBe('mine');
      expect(p.choices.find((c) => c.topic === 'outbound')!.why).toMatch(/Kept from your earlier plan/);
      expect(p.choices.find((c) => c.topic === 'stay')!.why).toMatch(/Kept from your earlier plan/);
    }
  });

  it('does not ask the providers again for a part it was told to keep', async () => {
    const first = await planTrip();
    const plan = first.plans[0]!;
    let flightCalls = 0;
    let hotelCalls = 0;
    await planTrip({
      keep: { outbound: plan.outboundTransport, return: plan.returnTransport, hotel: plan.hotels[0] ?? null },
      parts: {
        flights: [flightProvider('flights', async () => (flightCalls++, answers.empty('flights')))],
        hotels: [hotelProvider('hotels', async () => (hotelCalls++, answers.empty('hotels')))],
      },
    });
    expect(flightCalls).toBe(0);
    expect(hotelCalls).toBe(0);
  });
});

describe('stopping a search', () => {
  it('stops when cancelled during a provider call, and returns no plans', async () => {
    const controller = new AbortController();
    const search = planTrip({
      signal: controller.signal,
      parts: { flights: [flightProvider('flights', never)] },
    });
    setTimeout(() => controller.abort(new Error('cancelled')), 20);
    // A provider that never answers is given up on by the policy's own deadline in
    // production; here it is the caller's cancellation that must end the search.
    await expect(Promise.race([search, new Promise((_, rej) => setTimeout(() => rej(new Error('did not stop')), 3_000))])).rejects.toThrow();
  });

  it('stops before doing anything when it is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(planTrip({ signal: controller.signal })).rejects.toThrow(/cancelled/);
  });
});

describe('a whole day-by-day itinerary comes with the plan', () => {
  it('has the journey, check-in, meals, check-out and the way home, in order and without overlaps', async () => {
    const { plans } = await planTrip();
    const plan = plans[0]!;
    const items: ItineraryItem[] = plan.days.flatMap((d) => d.items).sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(['transport', 'check_in', 'meal', 'check_out']));
    expect(kinds.indexOf('check_in')).toBeLessThan(kinds.indexOf('check_out'));
    for (let i = 1; i < items.length; i += 1) {
      if (items[i]!.kind === 'rest' || items[i - 1]!.kind === 'rest') continue;
      expect(Date.parse(items[i]!.startUtc)).toBeGreaterThanOrEqual(Date.parse(items[i - 1]!.endUtc));
    }
    expect(plan.days.length).toBeGreaterThanOrEqual(5);
    expect(plan.cost.total.amount).toBeGreaterThan(0);
  });
});

describe('domestic trips choose among flying, the train, the coach and driving', () => {
  const FUEL = { currency: 'INR', consumptionPer100Km: 7.5, energyPrice: 105, perKmAllowance: 1.5, maxDrivingHoursBeforeBreak: 3, breakMinutes: 30, averageOccupancy: 2 };
  const modes = (profile: typeof FUEL | null) => ({
    flights: [flightProvider('flights', async (req: { departureDate: string; origin: { name: string } }) => answers.ok([journey({ id: 'flight', rupees: 9_600, departs: req.origin.name === 'Bengaluru' ? 16 * 60 : 8 * 60, minutes: 75 }, req.departureDate, req.origin.name === 'Bengaluru' ? 'BLR' : 'HYD', req.origin.name === 'Bengaluru' ? 'HYD' : 'BLR')]))],
    rail: [railProvider('rail', async (req: { date: string }) => answers.ok([surface('train', { id: 'train', rupees: 2_400, departs: 21 * 60, minutes: 630, overnight: true }, req.date)]), ['IN'])],
    buses: [busProvider('bus', async (req: { date: string }) => answers.ok([surface('bus', { id: 'bus', rupees: 1_800, departs: 20 * 60, minutes: 690, overnight: true }, req.date)]), ['IN'])],
    selfDrive: { distanceKm: 570, durationMinutes: 540, profile },
  });

  it('takes the cheapest known way for the Budget plan, counting fuel, and the quickest for Comfort', async () => {
    const { plans, transport } = await planTrip({ parts: modes(FUEL) });
    expect(transport.outbound.modes.filter((m) => m.offers.length > 0).map((m) => m.mode).sort()).toEqual(['bus', 'flight', 'self_drive', 'train']);
    // Driving's fare is ₹0, but its fuel is counted, so the coach (₹1,800) is cheaper than the drive (about ₹5,000).
    expect(planOf(plans, 'budget')!.outboundTransport!.mode).toBe('bus');
    expect(planOf(plans, 'comfort')!.outboundTransport!.mode).toBe('flight');
  });

  it('says what it could not price when the cheapest-looking option is driving with no vehicle profile', async () => {
    const { plans } = await planTrip({ parts: modes(null) });
    const budget = planOf(plans, 'budget')!;
    expect(budget.outboundTransport!.mode).toBe('self_drive');
    expect(budget.tradeoffs.join(' ')).toMatch(/not fully known.*fuel.*will cost more than shown/i);
  });

  it('builds every plan around the way the traveller asked to travel, when it can be done', async () => {
    const { plans } = await planTrip({ parts: modes(FUEL), profile: { transport: { ...emptyTravelerProfile().transport, preferredMode: 'train' } } });
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) expect(plan.outboundTransport!.mode).toBe('train');
  });

  it('leaves out every overnight way of travelling when asked, and drives or flies instead', async () => {
    const { plans, transport } = await planTrip({
      parts: modes(FUEL),
      profile: { transport: { ...emptyTravelerProfile().transport, avoidOvernightTravel: true } },
    });
    expect(transport.outbound.filtered.map((f) => f.reason).join(' ')).toMatch(/overnight/);
    for (const plan of plans) expect(['flight', 'self_drive']).toContain(plan.outboundTransport!.mode);
  });
});
