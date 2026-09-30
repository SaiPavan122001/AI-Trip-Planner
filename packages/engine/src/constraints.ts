import {
  findHard,
  hasWaiver,
  multiply,
  nightsBetween,
  priorityWeights,
  seatedTravelers,
  type BudgetEnvelope,
  type ConstraintSet,
  type HardConstraint,
  type Money,
  type SoftPreference,
  type TravelStyle,
  type TravelerProfile,
  type TripIntent,
} from '@trip/shared';

/**
 * Turns what the traveller told us into the constraint set the planner is
 * bound by. The separation matters: hard constraints are filters applied
 * before scoring, soft preferences are weights applied during scoring. A plan
 * that breaks a hard constraint is not a worse plan, it is not a plan.
 */

/**
 * How a stated style splits a total budget across the big three. These are
 * starting points used only when the traveller has not given a per-category
 * budget; they are shown in the UI as "assumed" and can be overridden.
 */
const STYLE_BUDGET_SPLIT: Record<TravelStyle, { transport: number; accommodation: number; daily: number }> = {
  budget: { transport: 0.4, accommodation: 0.35, daily: 0.25 },
  standard: { transport: 0.4, accommodation: 0.4, daily: 0.2 },
  premium: { transport: 0.42, accommodation: 0.42, daily: 0.16 },
  luxury: { transport: 0.45, accommodation: 0.4, daily: 0.15 },
};

/** Minimum property category a style implies when the traveller did not say. */
const STYLE_MIN_CATEGORY: Record<TravelStyle, number | null> = {
  budget: null,
  standard: 3,
  premium: 4,
  luxury: 5,
};

export interface BudgetAnswers {
  total: Money | null;
  transport: Money | null;
  accommodation: Money | null;
  dailySpendPerPerson: Money | null;
  /** The traveller said the total must never be exceeded. Absent means a guide. */
  firm?: boolean;
}

export function buildConstraints(
  intent: TripIntent,
  profile: TravelerProfile,
  budget: BudgetAnswers,
): ConstraintSet {
  const hard: HardConstraint[] = [];
  const soft: SoftPreference[] = [];

  // --- hard: dates, party, budget ceilings ---------------------------------
  hard.push({ kind: 'fixed_departure_date', value: intent.departureDate });
  if (intent.returnDate) hard.push({ kind: 'fixed_return_date', value: intent.returnDate });
  hard.push({ kind: 'traveler_count', value: intent.travelers });

  // A budget is a guide unless the traveller said "do not exceed". Only a
  // firm total becomes a hard constraint; otherwise it shapes the ranking and
  // the warnings, and nothing is filtered out for being dear. The derived
  // transport and accommodation allowances are never hard: a dear flight
  // beside a cheap hotel can still fit the total. When the total is firm, no
  // single part may exceed all of it, which is the most that can be said of
  // one part on its own.
  const firmTotal = budget.firm === true ? budget.total : null;
  if (firmTotal) hard.push({ kind: 'max_total_budget', value: firmTotal });
  const transportCap = budget.transport ?? firmTotal;
  if (transportCap) hard.push({ kind: 'max_transport_budget', value: transportCap });
  const accommodationCap = budget.accommodation ?? firmTotal;
  if (accommodationCap) hard.push({ kind: 'max_accommodation_budget', value: accommodationCap });

  // --- hard: stated requirements -------------------------------------------
  if (profile.accommodation.rooms > 1) {
    hard.push({ kind: 'required_rooms', value: profile.accommodation.rooms });
  }
  if (profile.special.accessibility.length > 0) {
    hard.push({ kind: 'required_accessibility', value: profile.special.accessibility });
  }
  if (profile.accommodation.freeCancellationRequired) {
    hard.push({ kind: 'required_free_cancellation', value: true });
  }
  for (const mode of profile.transport.excludedModes) {
    hard.push({ kind: 'excluded_transport_mode', value: mode });
  }
  if (profile.transport.maxStops !== null) {
    hard.push({ kind: 'max_stops', value: profile.transport.maxStops });
  }
  if (profile.transport.checkedBagsPerTraveler > 0) {
    hard.push({ kind: 'required_checked_bags', value: profile.transport.checkedBagsPerTraveler });
  }
  if (profile.transport.latestArrivalLocal) {
    hard.push({ kind: 'latest_arrival_time', value: profile.transport.latestArrivalLocal });
  }
  if (profile.transport.earliestDepartureLocal) {
    hard.push({ kind: 'earliest_departure_time', value: profile.transport.earliestDepartureLocal });
  }

  // --- soft: ranked priorities and everything that only nudges -------------
  const weights = priorityWeights(profile.priorities);
  if (profile.priorities.length > 0) {
    soft.push({ kind: 'priority_order', value: profile.priorities, weight: 1 });
  }
  if (profile.transport.cabinClass) {
    soft.push({
      kind: 'preferred_cabin_class',
      value: profile.transport.cabinClass,
      weight: 0.8,
    });
  }
  for (const carrier of profile.transport.preferredCarriers) {
    soft.push({ kind: 'preferred_carrier', value: carrier, weight: 0.5 });
  }
  for (const carrier of profile.transport.avoidedCarriers) {
    soft.push({ kind: 'avoided_carrier', value: carrier, weight: 0.6 });
  }

  const minCategory =
    profile.accommodation.minCategory ??
    (profile.travelStyle ? STYLE_MIN_CATEGORY[profile.travelStyle] : null);
  if (minCategory) {
    // A stated minimum is hard; one inferred from style is only a preference,
    // because the traveller never actually said it.
    if (profile.accommodation.minCategory) {
      soft.push({ kind: 'min_hotel_category', value: minCategory, weight: 1 });
    } else {
      soft.push({ kind: 'min_hotel_category', value: minCategory, weight: 0.6 });
    }
  }
  if (profile.accommodation.locationPreference) {
    soft.push({
      kind: 'preferred_hotel_area',
      value: profile.accommodation.locationPreference,
      weight: 0.7,
    });
  }
  if (profile.accommodation.breakfastIncluded) {
    soft.push({ kind: 'breakfast_included', value: true, weight: 0.4 });
  }
  if (weights.has('scenic')) {
    soft.push({ kind: 'scenic_route', value: true, weight: weights.get('scenic')! });
  }
  if (weights.has('fewest_transfers')) {
    soft.push({ kind: 'fewer_transfers', value: true, weight: weights.get('fewest_transfers')! });
  }
  if (weights.has('least_travel_time') || weights.has('fastest')) {
    soft.push({
      kind: 'shorter_journey',
      value: true,
      weight: Math.max(weights.get('least_travel_time') ?? 0, weights.get('fastest') ?? 0),
    });
  }
  if (budget.dailySpendPerPerson) {
    soft.push({ kind: 'daily_spend_target', value: budget.dailySpendPerPerson, weight: 0.5 });
  }

  return {
    hard,
    soft,
    budget: deriveEnvelope(intent, profile, budget),
    waivers: [],
  };
}

/**
 * Fills in the per-category budgets the traveller did not state, from the
 * total and the travel style. Derived figures are kept distinct from stated
 * ones by `isDerived` on the returned note, so the UI can label them.
 */
export function deriveEnvelope(
  intent: TripIntent,
  profile: TravelerProfile,
  budget: BudgetAnswers,
): BudgetEnvelope {
  const nights = nightsBetween(intent.departureDate, intent.returnDate);
  const people = Math.max(1, seatedTravelers(intent.travelers));
  const style = profile.travelStyle ?? 'standard';
  const split = STYLE_BUDGET_SPLIT[style];

  const dailyFromTotal =
    budget.total && nights > 0
      ? multiply(budget.total, split.daily / (nights * people))
      : null;

  return {
    total: budget.total,
    transport: budget.transport ?? (budget.total ? multiply(budget.total, split.transport) : null),
    accommodation:
      budget.accommodation ?? (budget.total ? multiply(budget.total, split.accommodation) : null),
    dailySpend: budget.dailySpendPerPerson ?? dailyFromTotal,
    activities: null,
    firm: budget.firm === true && budget.total !== null,
  };
}

/**
 * The ceiling a part of the trip must stay under, or null when there is none:
 * a guide budget imposes no ceiling, and one the traveller agreed to exceed
 * is lifted. Searches and filters read this, never the derived envelope.
 */
export function budgetCeiling(
  constraints: ConstraintSet,
  part: 'transport' | 'accommodation',
): Money | null {
  const kind = part === 'transport' ? 'max_transport_budget' : 'max_accommodation_budget';
  if (hasWaiver(constraints, kind) || hasWaiver(constraints, 'max_total_budget')) return null;
  return findHard(constraints, kind)?.value ?? null;
}

/**
 * The budget figures the traveller actually stated, recovered from a
 * constraint set. Only the total and the daily allowance are ever asked;
 * the transport and accommodation splits are always derived from the total
 * and the travel style, so they are returned as null to be derived afresh.
 *
 * Passing the derived envelope back in as if it were stated used to turn the
 * split into explicit hard constraints on the next answer, and kept it fixed
 * when the total later changed.
 */
export function statedBudget(constraints: ConstraintSet, profile: TravelerProfile): BudgetAnswers {
  return {
    total: constraints.budget.total,
    firm: constraints.budget.firm,
    transport: null,
    accommodation: null,
    // The envelope fills dailySpend from the total when none was stated, so
    // only count it as stated when the question was answered.
    dailySpendPerPerson: profile.answeredKeys.includes('budget.daily_spend')
      ? constraints.budget.dailySpend
      : null,
  };
}

/**
 * Rebuilds the constraint set after the trip, the profile or the budget
 * changes, so every derived figure and rule follows the change. Waivers the
 * traveller granted are kept unless the change makes them meaningless.
 */
export function rebuildConstraints(
  intent: TripIntent,
  profile: TravelerProfile,
  previous: ConstraintSet,
  budget: BudgetAnswers = statedBudget(previous, profile),
): ConstraintSet {
  return { ...buildConstraints(intent, profile, budget), waivers: previous.waivers };
}

/** Which envelope figures were inferred rather than stated, for the UI. */
export function derivedBudgetKeys(budget: BudgetAnswers): string[] {
  const derived: string[] = [];
  if (!budget.transport) derived.push('transport');
  if (!budget.accommodation) derived.push('accommodation');
  if (!budget.dailySpendPerPerson) derived.push('dailySpend');
  return derived;
}
