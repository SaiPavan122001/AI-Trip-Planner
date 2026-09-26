import {
  ModificationRequest,
  SUPPORTED_CURRENCY,
  addMinutes,
  formatMoney,
  localParts,
  nightsBetween,
  seatedTravelers,
  totalTravelers,
  type ConstraintSet,
  type HardConstraintKind,
  type IsoDate,
  type JourneyClassification,
  type Priority,
  type ProposedChange,
  type TravelerProfile,
  type TripComponent,
  type TripIntent,
} from '@trip/shared';
import { rebuildConstraints, statedBudget, type BudgetAnswers } from './constraints.js';

/**
 * Conversational modification, applied deterministically.
 *
 * The AI layer's job is to turn "make it cheaper, but keep the hotel" into a
 * `ModificationRequest`. This module's job is to work out, in full and before
 * anything is saved, what that request means for this trip: the new facts,
 * preferences and constraints, which parts of the plan are searched again,
 * which are kept exactly as they were, and which pinned parts can no longer
 * be kept (with the reason). Nothing here talks to a provider or a store.
 *
 * The split matters: a model that could edit constraints directly could talk
 * itself into a plan that violates the traveller's budget. Here it can only
 * name an intent, and the rules for each intent are written down.
 */

export interface ModificationContext {
  intent: TripIntent;
  classification: JourneyClassification;
  profile: TravelerProfile;
  constraints: ConstraintSet;
  /** Parts present in the currently selected plan; empty before planning. */
  planComponents: TripComponent[];
  /** Today's date where the trip starts. Injected so tests are stable. */
  today?: IsoDate;
}

export type ModificationOutcome =
  | { status: 'no_change'; summary: string }
  | { status: 'apply'; change: ProposedChange }
  | {
      status: 'needs_consent';
      question: string;
      acceptLabel: string;
      declineLabel: string;
      accept: ProposedChange;
      /** Null when declining means nothing changes. */
      decline: ProposedChange | null;
    };

const ALL: readonly TripComponent[] = ['outbound', 'return', 'hotel', 'transfers', 'activities'];

/** What an intent changes, before pins and the current plan are applied. */
interface Draft {
  intent: TripIntent;
  profile: TravelerProfile;
  budget?: BudgetAnswers;
  /** Waiver kinds to add, and kinds to withdraw, after constraints are rebuilt. */
  grant?: Array<{ kind: HardConstraintKind; reason: string }>;
  withdraw?: HardConstraintKind[];
  reSearch: TripComponent[];
  /** Parts that can never be kept after this change, even if pinned. */
  invalidates?: { components: TripComponent[]; reason: string };
  summary: string;
}

const noChange = (summary: string): ModificationOutcome => ({ status: 'no_change', summary });

const MODE_LABEL: Record<string, string> = {
  flight: 'flights',
  train: 'trains',
  bus: 'buses',
  self_drive: 'driving your own car',
  rental_car: 'a rental car',
  taxi: 'a private car',
  ferry: 'ferries',
};

export function applyModification(proposed: ModificationRequest, ctx: ModificationContext): ModificationOutcome {
  // The request usually comes from a language model. It has been validated
  // where it was produced, and is validated again here, at the boundary of
  // the code that changes the trip, so this function never depends on every
  // caller having remembered.
  const request = ModificationRequest.parse(proposed);
  const p = request.parameters;
  const hasPlan = ctx.planComponents.length > 0;
  const base = (): Pick<Draft, 'intent' | 'profile'> => ({
    intent: structuredClone(ctx.intent),
    profile: structuredClone(ctx.profile),
  });
  const finish = (draft: Draft) => finalise(draft, request.pinnedComponents, ctx);

  switch (request.intent) {
    case 'reduce_cost': {
      const d = base();
      d.profile.priorities = leading('cheapest', ctx.profile.priorities);
      return { status: 'apply', change: finish({ ...d, reSearch: ['outbound', 'return', 'hotel'], summary: 'Price is now the first thing the planner optimises for.' }) };
    }

    case 'increase_comfort': {
      const d = base();
      d.profile.priorities = leading('most_comfortable', ctx.profile.priorities);
      const raised = ctx.profile.accommodation.minCategory;
      if (raised !== null) d.profile.accommodation.minCategory = Math.min(5, raised + 1);
      const summary = `Comfort now leads the ranking${raised !== null ? `, and only ${d.profile.accommodation.minCategory}-star properties or better are considered` : ''}.`;
      const draft: Draft = { ...d, reSearch: ['outbound', 'return', 'hotel'], summary };
      const budget = ctx.constraints.budget.total;
      if (!budget) return { status: 'apply', change: finish(draft) };
      // More comfort may cost more than the budget. Both answers act: yes
      // lets the planner show options above it, no keeps the budget as a
      // hard limit and finds the most comfortable plan within it.
      return {
        status: 'needs_consent',
        question: `A more comfortable plan may cost more than your ${formatMoney(budget)} budget. Should the planner include options above it?`,
        acceptLabel: 'Yes, include options above my budget',
        declineLabel: 'No, stay within my budget',
        accept: finish({
          ...draft,
          grant: [{ kind: 'max_total_budget', reason: 'Agreed to see more comfortable options above the budget.' }],
          summary: `${summary} Options above your budget may be shown.`,
        }),
        decline: finish({ ...draft, summary: `${summary} Your budget stays a firm limit.` }),
      };
    }

    case 'change_transport_mode': {
      const mode = p.mode;
      if (!mode) return noChange('Which way would you like to travel: flight, train, bus or your own car?');
      const excluded = ctx.classification.excludedModes.find((e) => e.mode === mode);
      if (!ctx.classification.eligibleModes.includes(mode) && excluded) {
        return noChange(`Travelling by ${MODE_LABEL[mode] ?? mode} is not possible for this journey: ${excluded.reason}`);
      }
      const d = base();
      d.profile.transport.excludedModes = ctx.profile.transport.excludedModes.filter((m) => m !== mode);
      d.profile.transport.preferredMode = mode;
      return {
        status: 'apply',
        change: finish({
          ...d,
          reSearch: ['outbound', 'return'],
          summary: `Plans will use ${MODE_LABEL[mode] ?? mode} where an option can be found. Every other way of travelling is still shown for comparison.`,
        }),
      };
    }

    case 'change_hotel_tier': {
      if (p.category === undefined) return noChange('What minimum star rating should the accommodation have?');
      const d = base();
      d.profile.accommodation.minCategory = p.category === 0 ? null : p.category;
      return {
        status: 'apply',
        change: finish({
          ...d,
          reSearch: ['hotel'],
          summary: p.category === 0 ? 'Any star rating will be considered.' : `Only properties rated ${p.category} or above will be considered.`,
        }),
      };
    }

    case 'avoid_overnight': {
      const d = base();
      d.profile.transport.avoidOvernightTravel = true;
      return {
        status: 'apply',
        change: finish({ ...d, reSearch: ['outbound', 'return'], summary: 'Overnight journeys are now ruled out. Daytime options can cost more or take longer.' }),
      };
    }

    case 'shift_departure_time': {
      if (!p.earliestDeparture && !p.latestArrival) {
        return noChange('What time would you like to leave or arrive by? For example, "leave after 09:00".');
      }
      const d = base();
      if (p.earliestDeparture) d.profile.transport.earliestDepartureLocal = p.earliestDeparture;
      if (p.latestArrival) d.profile.transport.latestArrivalLocal = p.latestArrival;
      const parts = [
        p.earliestDeparture ? `leaving no earlier than ${p.earliestDeparture}` : null,
        p.latestArrival ? `arriving by ${p.latestArrival}` : null,
      ].filter(Boolean);
      return {
        status: 'apply',
        change: finish({ ...d, reSearch: ['outbound', 'return'], summary: `Journeys will be ${parts.join(' and ')}, in local time.` }),
      };
    }

    case 'change_dates': {
      const today = ctx.today ?? localParts(new Date().toISOString(), ctx.intent.origin.timezone).date;
      const departure = p.departureDate ?? ctx.intent.departureDate;
      let ret = p.returnDate ?? ctx.intent.returnDate;
      if (!p.departureDate && !p.returnDate) {
        return noChange('Which dates would you like to travel on?');
      }
      // Moving only the departure keeps the length of the trip.
      if (p.departureDate && !p.returnDate && ctx.intent.returnDate) {
        const nights = nightsBetween(ctx.intent.departureDate, ctx.intent.returnDate);
        ret = shiftDate(p.departureDate, nights);
      }
      if (departure < today) return noChange(`${departure} has already passed. Please choose a date from ${today} onwards.`);
      if (ret && ret < departure) return noChange(`The return date ${ret} would be before the departure date ${departure}.`);
      if (departure === ctx.intent.departureDate && ret === ctx.intent.returnDate) {
        return noChange('Those are already the dates of this trip.');
      }
      const d = base();
      d.intent.departureDate = departure;
      d.intent.returnDate = ret;
      const span = ret ? `${departure} to ${ret}` : departure;
      const accept = finish({
        ...d,
        reSearch: ['outbound', 'return', 'hotel'],
        invalidates: {
          components: ['outbound', 'return', 'hotel'],
          reason: 'it was for the old dates',
        },
        summary: `The trip now runs ${span}, and transport and accommodation are searched again for those dates.`,
      });
      return {
        status: 'needs_consent',
        question: `Change the trip to ${span}? Every price and schedule will be searched again for the new dates${keptDatedParts(request.pinnedComponents)}.`,
        acceptLabel: 'Yes, change the dates',
        declineLabel: 'No, keep my dates',
        accept,
        decline: null,
      };
    }

    case 'change_party_size': {
      if (p.adults === undefined && p.children === undefined && p.infants === undefined) {
        return noChange('How many adults, children and infants will be travelling?');
      }
      const travelers = {
        adults: p.adults ?? ctx.intent.travelers.adults,
        children: p.children ?? ctx.intent.travelers.children,
        infants: p.infants ?? ctx.intent.travelers.infants,
      };
      const same =
        travelers.adults === ctx.intent.travelers.adults &&
        travelers.children === ctx.intent.travelers.children &&
        travelers.infants === ctx.intent.travelers.infants;
      if (same) return noChange('That is already the size of your group.');
      const d = base();
      d.intent.travelers = travelers;
      const seated = seatedTravelers(travelers);
      let roomsNote = '';
      if (d.profile.accommodation.rooms > seated) {
        d.profile.accommodation.rooms = seated;
        roomsNote = ` Rooms are reduced to ${seated}, one per person at most.`;
      }
      const count = totalTravelers(travelers);
      return {
        status: 'needs_consent',
        question: `Plan for ${describeParty(travelers)}? Fares and rooms will be searched again for the new group${keptDatedParts(request.pinnedComponents, true)}.${roomsNote}`,
        acceptLabel: 'Yes, update the group',
        declineLabel: 'No, keep the group as it is',
        accept: finish({
          ...d,
          reSearch: ['outbound', 'return', 'hotel'],
          invalidates: { components: ['outbound', 'return', 'hotel'], reason: 'its price was for the previous group' },
          summary: `The trip is now for ${count} traveller${count === 1 ? '' : 's'}.${roomsNote}`,
        }),
        decline: null,
      };
    }

    case 'change_budget': {
      const total = p.budgetTotal;
      if (!total) return noChange('What would you like the total budget to be?');
      if (total.currency !== SUPPORTED_CURRENCY) return noChange(`Budgets are in Indian rupees (${SUPPORTED_CURRENCY}).`);
      if (ctx.constraints.budget.total && ctx.constraints.budget.total.amount === total.amount) {
        return noChange('That is already your budget.');
      }
      const d = base();
      if (!d.profile.answeredKeys.includes('budget.total')) d.profile.answeredKeys.push('budget.total');
      return {
        status: 'apply',
        change: finish({
          ...d,
          budget: { ...statedBudget(ctx.constraints, ctx.profile), total },
          // A new budget replaces any earlier agreement to go over the old one.
          withdraw: ['max_total_budget'],
          reSearch: ['outbound', 'return', 'hotel'],
          summary: `The total budget is now ${formatMoney(total)}, and the transport and accommodation allowances follow from it.`,
        }),
      };
    }

    case 'reprioritise': {
      if (!p.priorities) return noChange('What matters most to you: cost, speed, comfort, safety or something else?');
      const d = base();
      d.profile.priorities = p.priorities;
      return {
        status: 'apply',
        change: finish({ ...d, reSearch: ['outbound', 'return', 'hotel'], summary: `Priorities are now: ${p.priorities.join(', then ').replace(/_/g, ' ')}.` }),
      };
    }

    case 'replace_component': {
      if (!hasPlan) return noChange('There is no plan yet to change. Build your plans first.');
      if (!p.component) return noChange('Which part of the plan would you like to replace: the outbound journey, the return, the hotel or the activities?');
      if (p.component === 'transfers') {
        return noChange('Transfers are worked out from your journey and hotel. Replace one of those and the transfers follow.');
      }
      const d = base();
      return {
        status: 'apply',
        change: finish({ ...d, reSearch: [p.component], summary: `Only the ${componentName(p.component)} is searched again; the rest of the plan is kept as it is.` }),
      };
    }

    case 'add_activity':
    case 'remove_activity':
      return noChange(
        'Adding or removing individual places is not supported yet. You can ask for a fresh set of activities instead, and nothing else in the plan will change.',
      );

    case 'unknown':
    default:
      return noChange('That request was not understood clearly enough to change the plan safely, so nothing has been changed.');
  }
}

/**
 * Applies pins and the current plan to a draft: pinned parts are kept
 * exactly, unaffected parts are carried over, and anything that cannot be
 * kept is released with a reason the traveller is shown.
 */
function finalise(draft: Draft, pinnedList: TripComponent[], ctx: ModificationContext): ProposedChange {
  const pinned = new Set(pinnedList);
  const inPlan = new Set(ctx.planComponents);
  const invalid = new Set(draft.invalidates?.components ?? []);
  const requested = new Set(draft.reSearch);

  const reSearch: TripComponent[] = [];
  const keep: TripComponent[] = [];
  const released: ProposedChange['released'] = [];

  for (const c of ALL) {
    // Transfers are always worked out from the journey and the hotel, so
    // they are never carried over on their own.
    if (c === 'transfers') continue;
    if (!inPlan.has(c)) {
      if (pinned.has(c)) {
        released.push({
          component: c,
          reason: ctx.planComponents.length === 0
            ? 'There is no plan yet, so there is nothing to keep.'
            : `Your current plan has no ${componentName(c)} to keep.`,
        });
      }
      continue;
    }
    if (invalid.has(c)) {
      if (pinned.has(c)) released.push({ component: c, reason: `The ${componentName(c)} cannot be kept: ${draft.invalidates!.reason}.` });
      reSearch.push(c);
    } else if (pinned.has(c)) {
      keep.push(c);
    } else if (requested.has(c)) {
      reSearch.push(c);
    } else {
      keep.push(c);
    }
  }

  const journeyOrHotelChanges = reSearch.some((c) => c !== 'activities');
  if (pinned.has('transfers') && journeyOrHotelChanges) {
    released.push({
      component: 'transfers',
      reason: 'Transfers are recalculated whenever the journey or hotel changes.',
    });
  }

  let constraints = rebuildConstraints(
    draft.intent,
    draft.profile,
    ctx.constraints,
    draft.budget ?? statedBudget(ctx.constraints, draft.profile),
  );
  if (draft.withdraw?.length) {
    constraints = { ...constraints, waivers: constraints.waivers.filter((w) => !draft.withdraw!.includes(w.kind)) };
  }
  for (const g of draft.grant ?? []) constraints = grantWaiver(constraints, g.kind, g.reason);

  const keptPinned = keep.filter((c) => pinned.has(c));
  const parts = [draft.summary];
  if (keptPinned.length > 0) parts.push(`Kept as you asked: ${keptPinned.map(componentName).join(', ')}.`);
  for (const r of released) parts.push(r.reason);

  return {
    intent: draft.intent,
    profile: draft.profile,
    constraints,
    reSearch,
    keep,
    released,
    summary: parts.join(' '),
  };
}

/**
 * Records a traveller's explicit agreement to break one of their own hard
 * constraints. Nothing else in the codebase may add a waiver, and a waiver
 * always carries the reason it was granted.
 */
export function grantWaiver(
  constraints: ConstraintSet,
  kind: ConstraintSet['hard'][number]['kind'],
  reason: string,
): ConstraintSet {
  const next: ConstraintSet = structuredClone(constraints);
  if (!next.waivers.some((w) => w.kind === kind)) {
    next.waivers.push({ kind, waivedAt: new Date().toISOString(), reason });
  }
  return next;
}

/** Puts one priority first, keeping the rest in order, at most four in all. */
function leading(first: Priority, rest: Priority[]): Priority[] {
  return [first, ...rest.filter((p) => p !== first)].slice(0, 4);
}

function componentName(c: TripComponent): string {
  return { outbound: 'outbound journey', return: 'return journey', hotel: 'hotel', transfers: 'transfers', activities: 'activities' }[c];
}

function keptDatedParts(pinned: TripComponent[], party = false): string {
  const dated = pinned.filter((c) => c === 'outbound' || c === 'return' || c === 'hotel');
  if (dated.length === 0) return '';
  return `, so the ${dated.map(componentName).join(' and ')} you asked to keep will be replaced, because ${party ? 'its price was for the previous group' : 'it was booked for the old dates'}`;
}

function describeParty(t: TripIntent['travelers']): string {
  const part = (n: number, one: string, many: string) => (n === 0 ? null : `${n} ${n === 1 ? one : many}`);
  return [part(t.adults, 'adult', 'adults'), part(t.children, 'child', 'children'), part(t.infants, 'infant', 'infants')]
    .filter(Boolean)
    .join(', ');
}

function shiftDate(date: IsoDate, days: number): IsoDate {
  return addMinutes(`${date}T12:00:00.000Z`, days * 24 * 60).slice(0, 10);
}
