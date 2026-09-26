import { describe, expect, it } from 'vitest';
import {
  findHard,
  money,
  type ModificationParameters,
  type ModificationRequest,
  type ProposedChange,
  type TripComponent,
} from '@trip/shared';
import { classifyJourney } from '../classify.js';
import { buildConstraints, statedBudget } from '../constraints.js';
import { applyModification, type ModificationContext, type ModificationOutcome } from '../modify.js';
import { buildConstraintsOnly, intent, paris, profile } from './fixtures.js';

/**
 * Modifications, worked out in full before anything is saved. The fixture
 * trip is Hyderabad to Bengaluru, 10 to 14 November 2026, for two adults,
 * with a ₹50,000 budget and a complete plan.
 */

const FULL_PLAN: TripComponent[] = ['outbound', 'return', 'hotel', 'transfers', 'activities'];

function context(overrides: Partial<ModificationContext> = {}): ModificationContext {
  const tripIntent = intent();
  const p = profile({ priorities: ['fastest'], answeredKeys: ['budget.total'] });
  return {
    intent: tripIntent,
    classification: classifyJourney(tripIntent.origin, tripIntent.destination),
    profile: p,
    constraints: buildConstraints(tripIntent, p, {
      total: money(50_000, 'INR'),
      transport: null,
      accommodation: null,
      dailySpendPerPerson: null,
    }),
    planComponents: FULL_PLAN,
    today: '2026-10-01',
    ...overrides,
  };
}

const ask = (
  intentName: ModificationRequest['intent'],
  parameters: ModificationParameters = {},
  pinnedComponents: TripComponent[] = [],
  ctx = context(),
): ModificationOutcome =>
  applyModification(
    { utterance: 'test', intent: intentName, parameters, affectedComponents: [], pinnedComponents, requiresWaiver: [] },
    ctx,
  );

function applied(outcome: ModificationOutcome): ProposedChange {
  if (outcome.status !== 'apply') throw new Error(`expected apply, got ${outcome.status}`);
  return outcome.change;
}

describe('pins', () => {
  it('keeps a pinned hotel exactly and re-optimises everything else', () => {
    const change = applied(ask('reduce_cost', {}, ['hotel']));

    expect(change.keep).toContain('hotel');
    expect(change.reSearch).toEqual(['outbound', 'return']);
    expect(change.profile.priorities[0]).toBe('cheapest');
    expect(change.summary).toMatch(/Kept as you asked: hotel/);
  });

  it('carries over parts the request does not touch, even without a pin', () => {
    const change = applied(ask('change_hotel_tier', { category: 4 }));
    expect(change.reSearch).toEqual(['hotel']);
    expect(change.keep).toEqual(['outbound', 'return', 'activities']);
  });

  it('tells the traveller when a pinned transfer cannot be kept', () => {
    const change = applied(ask('reduce_cost', {}, ['transfers']));
    expect(change.released).toContainEqual({
      component: 'transfers',
      reason: 'Transfers are recalculated whenever the journey or hotel changes.',
    });
  });

  it('says there is nothing to keep before a plan exists', () => {
    const change = applied(ask('reduce_cost', {}, ['hotel'], context({ planComponents: [] })));
    expect(change.keep).toEqual([]);
    expect(change.reSearch).toEqual([]);
    expect(change.released[0]!.reason).toMatch(/no plan yet/);
  });
});

describe('consent', () => {
  it('asks before a comfort upgrade may break the budget, and both answers act', () => {
    const outcome = ask('increase_comfort');
    if (outcome.status !== 'needs_consent') throw new Error('expected consent');

    expect(outcome.question).toMatch(/₹50,000(\.00)? budget/);
    expect(outcome.accept.constraints.waivers.map((w) => w.kind)).toEqual(['max_total_budget']);
    expect(outcome.decline?.constraints.waivers).toEqual([]);
    // Either way, comfort now leads.
    expect(outcome.accept.profile.priorities[0]).toBe('most_comfortable');
    expect(outcome.decline?.profile.priorities[0]).toBe('most_comfortable');
  });

  it('needs no consent for more comfort when there is no budget', () => {
    const noBudget = context({ constraints: buildConstraintsOnly(profile()) });
    expect(ask('increase_comfort', {}, [], noBudget).status).toBe('apply');
  });
});

describe('changing dates', () => {
  it('keeps the length of the trip when only the departure moves, and asks first', () => {
    const outcome = ask('change_dates', { departureDate: '2026-12-01' });
    if (outcome.status !== 'needs_consent') throw new Error('expected consent');

    expect(outcome.accept.intent.departureDate).toBe('2026-12-01');
    expect(outcome.accept.intent.returnDate).toBe('2026-12-05');
    expect(outcome.decline).toBeNull();
    // The fixed-date constraints follow the new dates.
    expect(findHard(outcome.accept.constraints, 'fixed_departure_date')?.value).toBe('2026-12-01');
    expect(outcome.accept.reSearch).toEqual(['outbound', 'return', 'hotel']);
  });

  it('releases a pinned hotel that was for the old dates, and says so up front', () => {
    const outcome = ask('change_dates', { departureDate: '2026-12-01' }, ['hotel']);
    if (outcome.status !== 'needs_consent') throw new Error('expected consent');

    expect(outcome.question).toMatch(/hotel you asked to keep will be replaced/);
    expect(outcome.accept.keep).not.toContain('hotel');
    expect(outcome.accept.released[0]).toEqual({
      component: 'hotel',
      reason: 'The hotel cannot be kept: it was for the old dates.',
    });
  });

  it.each([
    [{ departureDate: '2026-09-01' }, /already passed/],
    [{ departureDate: '2026-12-10', returnDate: '2026-12-01' }, /before the departure date/],
    [{ departureDate: '2026-11-10', returnDate: '2026-11-14' }, /already the dates/],
    [{}, /Which dates/],
  ])('changes nothing for %o', (parameters, message) => {
    const outcome = ask('change_dates', parameters);
    expect(outcome.status).toBe('no_change');
    expect(outcome.status === 'no_change' && outcome.summary).toMatch(message);
  });
});

describe('changing the group', () => {
  it('asks before re-searching for a larger group', () => {
    const outcome = ask('change_party_size', { adults: 3 });
    if (outcome.status !== 'needs_consent') throw new Error('expected consent');
    expect(outcome.question).toMatch(/Plan for 3 adults/);
    expect(outcome.accept.intent.travelers).toEqual({ adults: 3, children: 0, infants: 0 });
  });

  it('never keeps more rooms than people', () => {
    const ctx = context();
    ctx.profile.accommodation.rooms = 2;
    const outcome = ask('change_party_size', { adults: 1 }, [], ctx);
    if (outcome.status !== 'needs_consent') throw new Error('expected consent');
    expect(outcome.accept.profile.accommodation.rooms).toBe(1);
    expect(outcome.question).toMatch(/Rooms are reduced to 1/);
  });

  it('asks for numbers rather than guessing them', () => {
    expect(ask('change_party_size').status).toBe('no_change');
  });
});

describe('changing the budget', () => {
  it('re-derives the transport and accommodation allowances from the new total', () => {
    const change = applied(ask('change_budget', { budgetTotal: money(80_000, 'INR') }));

    expect(change.constraints.budget.total).toEqual(money(80_000, 'INR'));
    // Standard style: 40% each, from the new total rather than the old one.
    expect(change.constraints.budget.transport).toEqual(money(32_000, 'INR'));
    // Derived allowances are not the traveller's words, so they never become
    // explicit hard constraints.
    expect(change.constraints.hard.map((h) => h.kind)).not.toContain('max_transport_budget');
  });

  it('replaces an earlier agreement to go over the old budget', () => {
    const ctx = context();
    ctx.constraints.waivers = [{ kind: 'max_total_budget', waivedAt: '2026-01-01T00:00:00.000Z', reason: 'test' }];
    const change = applied(ask('change_budget', { budgetTotal: money(80_000, 'INR') }, [], ctx));
    expect(change.constraints.waivers).toEqual([]);
  });
});

describe('other changes', () => {
  it('rebuilds the constraints, so a new time window is actually enforced', () => {
    const change = applied(ask('shift_departure_time', { earliestDeparture: '09:00' }));
    expect(findHard(change.constraints, 'earliest_departure_time')?.value).toBe('09:00');
  });

  it('remembers a requested mode as a preference, keeping others to compare', () => {
    const change = applied(ask('change_transport_mode', { mode: 'train' }));
    expect(change.profile.transport.preferredMode).toBe('train');
    expect(change.profile.transport.excludedModes).not.toContain('train');
  });

  it('refuses a mode this journey cannot use, and says why', () => {
    const international = intent({ destination: paris, destinationQuery: 'Paris' });
    const ctx = context({
      intent: international,
      classification: classifyJourney(international.origin, international.destination),
    });
    const outcome = ask('change_transport_mode', { mode: 'train' }, [], ctx);
    expect(outcome.status === 'no_change' && outcome.summary).toMatch(/not possible for this journey/);
  });

  it('replaces only the part asked for', () => {
    const change = applied(ask('replace_component', { component: 'hotel' }));
    expect(change.reSearch).toEqual(['hotel']);
    expect(change.keep).toEqual(['outbound', 'return', 'activities']);
  });

  it('says plainly that adding or removing single places is not supported yet', () => {
    const outcome = ask('add_activity', { activityName: 'Lalbagh' });
    expect(outcome.status === 'no_change' && outcome.summary).toMatch(/not supported yet/);
  });
});

describe('the engine boundary for modifications', () => {
  it('refuses unvalidated parameters even when a caller skipped validation', () => {
    const ctx = context();
    expect(() => ask('shift_departure_time', { earliestDeparture: '9am' } as never, [], ctx)).toThrow();
    expect(ctx.profile.transport.earliestDepartureLocal).toBeNull();
  });

  it('refuses a priority that does not exist', () => {
    expect(() => ask('reprioritise', { priorities: ['bribery'] } as never)).toThrow();
  });
});

describe('stated and derived budget figures', () => {
  it('counts only what the traveller actually answered as stated', () => {
    const ctx = context();
    const stated = statedBudget(ctx.constraints, ctx.profile);
    expect(stated.total).toEqual(money(50_000, 'INR'));
    expect(stated.transport).toBeNull();
    expect(stated.accommodation).toBeNull();
    // The envelope fills a daily figure from the total, but it was never asked.
    expect(ctx.constraints.budget.dailySpend).not.toBeNull();
    expect(stated.dailySpendPerPerson).toBeNull();
  });
});
