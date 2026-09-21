import {
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

  if (budget.total) hard.push({ kind: 'max_total_budget', value: budget.total });
  if (budget.transport) hard.push({ kind: 'max_transport_budget', value: budget.transport });
  if (budget.accommodation) {
    hard.push({ kind: 'max_accommodation_budget', value: budget.accommodation });
  }

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
  };
}

/** Which envelope figures were inferred rather than stated, for the UI. */
export function derivedBudgetKeys(budget: BudgetAnswers): string[] {
  const derived: string[] = [];
  if (!budget.transport) derived.push('transport');
  if (!budget.accommodation) derived.push('accommodation');
  if (!budget.dailySpendPerPerson) derived.push('dailySpend');
  return derived;
}
