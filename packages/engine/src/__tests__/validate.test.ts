import { describe, expect, it } from 'vitest';
import { money, zero, type ConstraintSet, type CostBreakdown, type ItineraryItem } from '@trip/shared';
import { classifyJourney } from '../classify.js';
import { validateItinerary } from '../validate.js';
import { intent, profile, transportOffer } from './fixtures.js';

const tripIntent = intent();
const classification = classifyJourney(tripIntent.origin, tripIntent.destination);

function item(overrides: Partial<ItineraryItem>): ItineraryItem {
  return {
    id: 'i1',
    kind: 'activity',
    title: 'Something',
    description: null,
    startUtc: '2026-11-11T04:00:00.000Z',
    endUtc: '2026-11-11T05:00:00.000Z',
    timezone: 'Asia/Kolkata',
    locationName: null,
    cost: null,
    costIsEstimate: false,
    offerRef: null,
    notes: [],
    ...overrides,
  };
}

function cost(total = 50_000): CostBreakdown {
  const z = zero('INR');
  return {
    transport: z,
    transportFees: z,
    accommodation: z,
    localTransport: z,
    activities: z,
    meals: z,
    other: z,
    total: money(total, 'INR'),
    perPerson: money(total / 2, 'INR'),
    estimatedPortion: z,
    remainingBudget: null,
    notIncluded: [],
  };
}

const noConstraints: ConstraintSet = { hard: [], soft: [], budget: {} as never, waivers: [] };

describe('itinerary validation', () => {
  it('blocks an itinerary where one item starts before the previous one ends', () => {
    const issues = validateItinerary({
      intent: tripIntent,
      classification,
      profile: profile(),
      constraints: noConstraints,
      items: [
        item({ id: 'a', startUtc: '2026-11-11T04:00:00.000Z', endUtc: '2026-11-11T06:00:00.000Z' }),
        item({ id: 'b', startUtc: '2026-11-11T05:00:00.000Z', endUtc: '2026-11-11T07:00:00.000Z' }),
      ],
      cost: cost(),
      outbound: null,
      inbound: null,
      hotel: null,
    });

    const overlap = issues.find((i) => i.code === 'overlapping_items');
    expect(overlap?.severity).toBe('blocker');
    expect(overlap?.itemIds).toEqual(['a', 'b']);
  });

  it('warns, but does not block, when a plan exceeds a budget that is only a guide', () => {
    const issues = validateItinerary({
      intent: tripIntent,
      classification,
      profile: profile(),
      constraints: {
        ...noConstraints,
        budget: { total: money(150_000, 'INR'), firm: false } as never,
      },
      items: [item({})],
      cost: cost(178_000),
      outbound: null,
      inbound: null,
      hotel: null,
    });

    const guide = issues.find((i) => i.code === 'over_budget_guide');
    expect(guide?.severity).toBe('warning');
    expect(guide?.message).toMatch(/guide/);
    expect(guide?.message).toMatch(/28,000/);
    expect(issues.map((i) => i.code)).not.toContain('budget_exceeded');
  });

  it('blocks a plan that exceeds a firm budget', () => {
    const issues = validateItinerary({
      intent: tripIntent,
      classification,
      profile: profile(),
      constraints: {
        ...noConstraints,
        budget: { total: money(150_000, 'INR'), firm: true } as never,
      },
      items: [item({})],
      cost: cost(178_000),
      outbound: null,
      inbound: null,
      hotel: null,
    });

    const budget = issues.find((i) => i.code === 'budget_exceeded');
    expect(budget?.severity).toBe('blocker');
    expect(budget?.message).toMatch(/1,78,000|178,000/);
  });

  it('downgrades the budget breach to a note once the traveller has waived it', () => {
    const issues = validateItinerary({
      intent: tripIntent,
      classification,
      profile: profile(),
      constraints: {
        ...noConstraints,
        budget: { total: money(150_000, 'INR'), firm: true } as never,
        waivers: [
          {
            kind: 'max_total_budget',
            waivedAt: '2026-01-01T00:00:00.000Z',
            reason: 'Traveller accepted the higher total.',
          },
        ],
      },
      items: [item({})],
      cost: cost(178_000),
      outbound: null,
      inbound: null,
      hotel: null,
    });

    expect(issues.find((i) => i.code === 'budget_exceeded')).toBeUndefined();
    expect(issues.find((i) => i.code === 'budget_exceeded_waived')?.severity).toBe('info');
  });

  it('blocks a plan that uses a mode the traveller ruled out', () => {
    const issues = validateItinerary({
      intent: tripIntent,
      classification,
      profile: profile(),
      constraints: {
        ...noConstraints,
        hard: [{ kind: 'excluded_transport_mode', value: 'flight' }],
      },
      items: [item({})],
      cost: cost(),
      outbound: transportOffer(),
      inbound: null,
      hotel: null,
    });

    expect(issues.find((i) => i.code === 'excluded_mode_used')?.severity).toBe('blocker');
  });

  it('warns about a late-night arrival rather than silently accepting it', () => {
    const lateArrival = transportOffer({
      segments: [
        {
          ...transportOffer().segments[0]!,
          departureAt: '2026-11-10T21:00:00',
          arrivalAt: '2026-11-10T23:45:00',
        },
      ],
    });

    const issues = validateItinerary({
      intent: tripIntent,
      classification,
      profile: profile(),
      constraints: noConstraints,
      items: [
        item({
          id: 'flight',
          kind: 'transport',
          startUtc: '2026-11-10T15:30:00.000Z',
          endUtc: '2026-11-10T18:15:00.000Z',
        }),
      ],
      cost: cost(),
      outbound: lateArrival,
      inbound: null,
      hotel: null,
    });

    const late = issues.find((i) => i.code === 'late_night_arrival');
    expect(late?.severity).toBe('warning');
    expect(late?.suggestions.length).toBeGreaterThan(0);
  });

  it('blocks a departure date that has already passed', () => {
    const issues = validateItinerary({
      intent: intent({ departureDate: '2020-01-01', returnDate: '2020-01-05' }),
      classification,
      profile: profile(),
      constraints: noConstraints,
      items: [item({})],
      cost: cost(),
      outbound: null,
      inbound: null,
      hotel: null,
    });

    expect(issues.find((i) => i.code === 'departure_in_past')?.severity).toBe('blocker');
  });

  it('surfaces unknown opening hours instead of assuming a venue is open', () => {
    const issues = validateItinerary({
      intent: tripIntent,
      classification,
      profile: profile(),
      constraints: noConstraints,
      items: [
        item({
          id: 'museum',
          notes: ['Opening hours are not published for this place. Check before you go.'],
        }),
      ],
      cost: cost(),
      outbound: null,
      inbound: null,
      hotel: null,
    });

    expect(issues.find((i) => i.code === 'opening_hours_unknown')?.severity).toBe('warning');
  });
});

describe('free time', () => {
  it('does not treat meals inside an unplanned day as overlapping it', () => {
    const rest = item({
      id: 'rest',
      kind: 'rest',
      title: 'Unplanned day',
      startUtc: '2026-11-11T04:00:00.000Z',
      endUtc: '2026-11-11T11:30:00.000Z',
    });
    const lunch = item({
      id: 'lunch',
      kind: 'meal',
      title: 'Lunch',
      startUtc: '2026-11-11T07:30:00.000Z',
      endUtc: '2026-11-11T08:30:00.000Z',
    });
    const issues = validateItinerary({
      intent: tripIntent,
      classification,
      profile: profile(),
      constraints: noConstraints,
      items: [rest, lunch],
      cost: cost(),
      outbound: null,
      inbound: null,
      hotel: null,
    });
    expect(issues.map((i) => i.code)).not.toContain('overlapping_items');
  });

  it('still flags two real commitments that overlap', () => {
    const a = item({ id: 'a', title: 'Museum', startUtc: '2026-11-11T04:00:00.000Z', endUtc: '2026-11-11T06:00:00.000Z' });
    const b = item({ id: 'b', title: 'Fort', startUtc: '2026-11-11T05:00:00.000Z', endUtc: '2026-11-11T07:00:00.000Z' });
    const issues = validateItinerary({
      intent: tripIntent,
      classification,
      profile: profile(),
      constraints: noConstraints,
      items: [a, b],
      cost: cost(),
      outbound: null,
      inbound: null,
      hotel: null,
    });
    expect(issues.map((i) => i.code)).toContain('overlapping_items');
  });
});

describe('checking out before the journey home', () => {
  const homeward = transportOffer({ id: 'home' });
  const check = (checkOutEnd: string) =>
    validateItinerary({
      intent: tripIntent,
      classification,
      profile: profile(),
      constraints: noConstraints,
      items: [
        item({ id: 'leave', kind: 'transport', startUtc: '2026-11-14T00:30:00.000Z', endUtc: '2026-11-14T01:45:00.000Z', offerRef: { kind: 'transport', offerId: 'home' } }),
        item({ id: 'out', kind: 'check_out', startUtc: '2026-11-14T05:40:00.000Z', endUtc: checkOutEnd }),
      ],
      cost: cost(),
      outbound: null,
      inbound: homeward,
      hotel: null,
    });

  it('blocks a check-out that finishes after the journey home has left', () => {
    const issue = check('2026-11-14T06:00:00.000Z').find((i) => i.code === 'check_out_after_departure');
    expect(issue?.severity).toBe('blocker');
    expect(issue?.itemIds).toEqual(['out', 'leave']);
  });

  it('accepts a check-out that is done in time', () => {
    const items = [
      item({ id: 'out', kind: 'check_out', startUtc: '2026-11-13T22:00:00.000Z', endUtc: '2026-11-13T22:20:00.000Z' }),
      item({ id: 'leave', kind: 'transport', startUtc: '2026-11-14T00:30:00.000Z', endUtc: '2026-11-14T01:45:00.000Z', offerRef: { kind: 'transport', offerId: 'home' } }),
    ];
    const issues = validateItinerary({ intent: tripIntent, classification, profile: profile(), constraints: noConstraints, items, cost: cost(), outbound: null, inbound: homeward, hotel: null });
    expect(issues.map((i) => i.code)).not.toContain('check_out_after_departure');
  });
});
