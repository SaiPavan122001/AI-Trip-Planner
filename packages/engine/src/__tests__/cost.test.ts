import { describe, expect, it } from 'vitest';
import { money, type ConstraintSet, type ItineraryItem } from '@trip/shared';
import { computeCost, detectBudgetConflict } from '../cost.js';
import { intent, transportOffer } from './fixtures.js';

const tripIntent = intent();

function item(kind: ItineraryItem['kind'], amount: number, estimate = false): ItineraryItem {
  return {
    id: `${kind}-${amount}`,
    kind,
    title: kind,
    description: null,
    startUtc: '2026-11-11T04:00:00.000Z',
    endUtc: '2026-11-11T05:00:00.000Z',
    timezone: 'Asia/Kolkata',
    locationName: null,
    cost: money(amount, 'INR'),
    costIsEstimate: estimate,
    offerRef: null,
    notes: [],
  };
}

const constraints = (total?: number): ConstraintSet => ({
  hard: [],
  soft: [],
  budget: {
    total: total ? money(total, 'INR') : null,
    transport: null,
    accommodation: null,
    dailySpend: null,
    activities: null,
  },
  waivers: [],
});

describe('cost aggregation', () => {
  it('counts every component the itinerary implies, not just the fare', () => {
    const breakdown = computeCost({
      intent: tripIntent,
      items: [item('transfer', 1200, true), item('activity', 800), item('meal', 2000, true)],
      outbound: transportOffer({ totalPrice: money(9600, 'INR') }),
      inbound: transportOffer({ totalPrice: money(9600, 'INR') }),
      hotel: null,
      constraints: constraints(),
    });

    expect(breakdown.transport).toEqual(money(19_200, 'INR'));
    expect(breakdown.localTransport).toEqual(money(1200, 'INR'));
    expect(breakdown.activities).toEqual(money(800, 'INR'));
    expect(breakdown.meals).toEqual(money(2000, 'INR'));
    expect(breakdown.total).toEqual(money(23_200, 'INR'));
  });

  it('separates modelled figures from quoted ones', () => {
    const breakdown = computeCost({
      intent: tripIntent,
      items: [item('transfer', 1200, true), item('activity', 800, false)],
      outbound: null,
      inbound: null,
      hotel: null,
      constraints: constraints(),
    });

    // The traveller can be told exactly how much of the total is a model.
    expect(breakdown.estimatedPortion).toEqual(money(1200, 'INR'));
  });

  it('divides the total across the people who are actually seated', () => {
    const breakdown = computeCost({
      intent: intent({ travelers: { adults: 2, children: 2, infants: 1 } }),
      items: [item('activity', 4000)],
      outbound: null,
      inbound: null,
      hotel: null,
      constraints: constraints(),
    });

    expect(breakdown.perPerson).toEqual(money(1000, 'INR'));
  });

  it('reports what is left of the budget', () => {
    const breakdown = computeCost({
      intent: tripIntent,
      items: [item('activity', 40_000)],
      outbound: null,
      inbound: null,
      hotel: null,
      constraints: constraints(150_000),
    });

    expect(breakdown.remainingBudget).toEqual(money(110_000, 'INR'));
  });
});

describe('budget conflict', () => {
  const overBudget = computeCost({
    intent: tripIntent,
    items: [item('activity', 28_000)],
    outbound: transportOffer({ totalPrice: money(150_000, 'INR') }),
    inbound: null,
    hotel: null,
    constraints: constraints(150_000),
  });

  it('says nothing when the plan fits', () => {
    const fits = computeCost({
      intent: tripIntent,
      items: [item('activity', 1000)],
      outbound: null,
      inbound: null,
      hotel: null,
      constraints: constraints(150_000),
    });
    expect(
      detectBudgetConflict(fits, constraints(150_000), {
        cheaperTransport: null,
        currentTransport: null,
        hotel: null,
        hasActivities: false,
      }),
    ).toBeNull();
  });

  it('reports the gap and offers adjustments without applying any', () => {
    const conflict = detectBudgetConflict(overBudget, constraints(150_000), {
      currentTransport: transportOffer({ totalPrice: money(150_000, 'INR') }),
      cheaperTransport: transportOffer({
        id: 'train',
        mode: 'train',
        totalPrice: money(3700, 'INR'),
        totalDurationMinutes: 500,
      }),
      hotel: null,
      hasActivities: true,
    });

    expect(conflict).not.toBeNull();
    expect(conflict!.overBy).toEqual(money(28_000, 'INR'));
    expect(conflict!.adjustments.length).toBeGreaterThan(1);
    // The biggest saving is offered first, and "accept the higher total" is
    // always available: the traveller decides, not the planner.
    expect(conflict!.adjustments[0]!.estimatedSaving).not.toBeNull();
    expect(conflict!.adjustments.some((a) => a.id === 'raise-budget')).toBe(true);
  });

  it('states the trade-off for every adjustment it suggests', () => {
    const conflict = detectBudgetConflict(overBudget, constraints(150_000), {
      currentTransport: transportOffer({ totalPrice: money(150_000, 'INR') }),
      cheaperTransport: transportOffer({
        id: 'train',
        mode: 'train',
        totalPrice: money(3700, 'INR'),
        totalDurationMinutes: 500,
      }),
      hotel: null,
      hasActivities: true,
    });

    for (const adjustment of conflict!.adjustments) {
      expect(adjustment.tradeoff.length).toBeGreaterThan(10);
    }
  });
});
