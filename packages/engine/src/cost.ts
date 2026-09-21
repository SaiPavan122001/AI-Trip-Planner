import {
  add,
  divide,
  formatMoney,
  isGreater,
  multiply,
  seatedTravelers,
  subtract,
  toMajor,
  zero,
  type ConstraintSet,
  type CostBreakdown,
  type ItineraryItem,
  type Money,
  type SelectedHotel,
  type TransportOffer,
  type TripIntent,
} from '@trip/shared';

/**
 * Cost aggregation and budget conflict detection.
 *
 * The number that matters to a traveller is the one they will actually spend,
 * so the breakdown counts everything the itinerary implies: fares, the fees
 * providers itemise separately, rooms, every transfer, activities and the
 * daily allowance for food. Estimated components are totalled separately from
 * quoted ones, so the UI can say "X of this total is modelled, not quoted".
 */

export interface CostInput {
  intent: TripIntent;
  items: ItineraryItem[];
  outbound: TransportOffer | null;
  inbound: TransportOffer | null;
  hotel: SelectedHotel | null;
  constraints: ConstraintSet;
}

export function computeCost(input: CostInput): CostBreakdown {
  const currency = input.intent.currency;
  const z = zero(currency);
  const sum = (values: Money[]): Money => (values.length ? add(...values) : z);
  const inCurrency = (m: Money | null): m is Money => m !== null && m.currency === currency;

  const transportFares = [input.outbound, input.inbound]
    .filter((o): o is TransportOffer => o !== null)
    .map((o) => o.totalPrice)
    .filter(inCurrency);

  const transportFees = [input.outbound, input.inbound]
    .filter((o): o is TransportOffer => o !== null)
    .flatMap((o) => o.itemisedFees.filter((f) => !f.included).map((f) => f.amount))
    .filter(inCurrency);

  const accommodation = input.hotel && inCurrency(input.hotel.room.totalPrice)
    ? multiply(input.hotel.room.totalPrice, input.hotel.rooms)
    : z;

  const localTransport = sum(
    input.items
      .filter((i) => i.kind === 'transfer')
      .map((i) => i.cost)
      .filter(inCurrency),
  );

  const activities = sum(
    input.items
      .filter((i) => i.kind === 'activity')
      .map((i) => i.cost)
      .filter(inCurrency),
  );

  const meals = sum(
    input.items
      .filter((i) => i.kind === 'meal')
      .map((i) => i.cost)
      .filter(inCurrency),
  );

  const transport = sum(transportFares);
  const fees = sum(transportFees);
  const other = z;

  const total = add(transport, fees, accommodation, localTransport, activities, meals, other);
  const people = Math.max(1, seatedTravelers(input.intent.travelers));

  const estimatedPortion = sum(
    input.items
      .filter((i) => i.costIsEstimate)
      .map((i) => i.cost)
      .filter(inCurrency),
  );

  const budget = input.constraints.budget.total;
  const remainingBudget =
    budget && budget.currency === currency ? subtract(budget, total) : null;

  return {
    transport,
    transportFees: fees,
    accommodation,
    localTransport,
    activities,
    meals,
    other,
    total,
    perPerson: divide(total, people),
    estimatedPortion,
    remainingBudget,
  };
}

export interface BudgetConflict {
  overBy: Money;
  budget: Money;
  total: Money;
  /** Ordered by how much they save, largest first. */
  adjustments: BudgetAdjustment[];
}

export interface BudgetAdjustment {
  id: string;
  label: string;
  /** What this would save, when it can be quantified from data we hold. */
  estimatedSaving: Money | null;
  /** Honest statement of what is given up. */
  tradeoff: string;
  /** The component that would be re-searched if the traveller accepts. */
  affects: 'outbound' | 'return' | 'hotel' | 'activities' | 'dates' | 'all';
}

/**
 * Detects a budget breach and proposes ways out. Nothing here changes the
 * plan: the adjustments are offers the traveller can take, because silently
 * downgrading a hotel to hit a number is exactly the behaviour that makes
 * travel sites untrustworthy.
 */
export function detectBudgetConflict(
  cost: CostBreakdown,
  constraints: ConstraintSet,
  context: {
    cheaperTransport: TransportOffer | null;
    currentTransport: TransportOffer | null;
    hotel: SelectedHotel | null;
    hasActivities: boolean;
  },
): BudgetConflict | null {
  const budget = constraints.budget.total;
  if (!budget || budget.currency !== cost.total.currency) return null;
  if (!isGreater(cost.total, budget)) return null;

  const overBy = subtract(cost.total, budget);
  const adjustments: BudgetAdjustment[] = [];

  if (context.cheaperTransport && context.currentTransport) {
    const saving = subtract(context.currentTransport.totalPrice, context.cheaperTransport.totalPrice);
    if (saving.amount > 0) {
      const extraMinutes =
        context.cheaperTransport.totalDurationMinutes - context.currentTransport.totalDurationMinutes;
      adjustments.push({
        id: 'switch-transport',
        label: `Travel by ${context.cheaperTransport.mode.replace('_', ' ')} instead`,
        estimatedSaving: saving,
        tradeoff:
          extraMinutes > 0
            ? `Adds about ${Math.round(extraMinutes / 60)}h to the journey each way.`
            : 'Different departure times and operator.',
        affects: 'outbound',
      });
    }
  }

  if (context.hotel) {
    // A tier down is modelled at a quarter off the room rate. It is labelled
    // as an estimate and is re-searched for real if the traveller accepts.
    const saving = multiply(context.hotel.room.totalPrice, 0.25 * context.hotel.rooms);
    adjustments.push({
      id: 'lower-hotel-tier',
      label: 'Drop the accommodation a category',
      estimatedSaving: saving,
      tradeoff: `You would be looking at properties below ${context.hotel.hotel.category ?? 'the current'} star, which usually means a less central location.`,
      affects: 'hotel',
    });
  }

  if (context.hasActivities && cost.activities.amount > 0) {
    adjustments.push({
      id: 'trim-activities',
      label: 'Drop the paid activities',
      estimatedSaving: cost.activities,
      tradeoff: 'Free sights and walking stay in the plan; ticketed ones come out.',
      affects: 'activities',
    });
  }

  adjustments.push({
    id: 'shift-dates',
    label: 'Try different travel dates',
    estimatedSaving: null,
    tradeoff:
      'Fares and room rates move a lot by date. The planner would need to re-search to say by how much.',
    affects: 'dates',
  });

  adjustments.push({
    id: 'raise-budget',
    label: `Accept a total of ${formatMoney(cost.total)}`,
    estimatedSaving: null,
    tradeoff: `That is ${formatMoney(overBy)} above the budget you set. Nothing changes in the plan.`,
    affects: 'all',
  });

  adjustments.sort(
    (a, b) => (b.estimatedSaving ? toMajor(b.estimatedSaving) : -1) - (a.estimatedSaving ? toMajor(a.estimatedSaving) : -1),
  );

  return { overBy, budget, total: cost.total, adjustments };
}
