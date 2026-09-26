import { rankPlans, type KeptComponents } from '@trip/engine';
import {
  SUPPORTED_CURRENCY,
  findHard,
  multiply,
  nightsBetween,
  seatedTravelers,
  type ConstraintSet,
  type Money,
  type TransportOffer,
  type TravelerProfile,
  type TripIntent,
  type TripPlan,
  type ValidationIssue,
} from '@trip/shared';
import { assessBudget } from './budget-service.js';

/**
 * The Validation Service: the last gate before a plan may be presented.
 *
 * The engine already validates while it builds. This is a second, independent
 * check on the finished plan, written against the traveller's trip rather than
 * against the engine's own reasoning, so a defect in one is caught by the
 * other, and so nothing an agent or a stale pin contributed can slip through
 * on trust.
 *
 * It re-derives what it can from first principles (dates, party, arithmetic,
 * currency, hard constraints, kept parts) and turns every failure into a
 * blocker on the plan with a reason. A plan with any blocker is not presented
 * as workable: it sorts last, and the synthesis step says so. Nothing here is
 * asked of a model.
 */

export interface ValidationInput {
  intent: TripIntent;
  profile: TravelerProfile;
  constraints: ConstraintSet;
  plans: TripPlan[];
  /** Parts the traveller pinned that were carried over as they were. Each must reappear unchanged. */
  kept?: KeptComponents;
}

export interface PlanValidation {
  planId: string;
  valid: boolean;
  /** Blockers found by this service (the engine's own are on the plan). */
  added: ValidationIssue[];
}

export interface ValidationReport {
  /** The same plans, with this service's blockers added, ranked with valid ones first. */
  plans: TripPlan[];
  results: PlanValidation[];
  /** At least one plan has no blocker of any origin. */
  anyValid: boolean;
}

const datePart = (local: string) => local.slice(0, 10);

const blocker = (code: string, message: string, itemIds: string[] = []): ValidationIssue => ({
  code: `validation.${code}`,
  severity: 'blocker',
  message,
  itemIds,
  suggestions: [],
});

const sameMoney = (a: Money, b: Money) => a.currency === b.currency && a.amount === b.amount;

function legDate(offer: TransportOffer | null): string | null {
  const first = offer?.segments[0];
  return first ? datePart(first.departureAt) : null;
}

export function validatePlan(plan: TripPlan, input: ValidationInput): ValidationIssue[] {
  const { intent, profile, constraints } = input;
  const found: ValidationIssue[] = [];
  const add = (issue: ValidationIssue) => found.push(issue);

  // ---- dates ----------------------------------------------------------------
  const outboundDate = legDate(plan.outboundTransport);
  if (plan.outboundTransport && outboundDate !== intent.departureDate) {
    add(blocker('outbound_date', `The outbound journey leaves on ${outboundDate ?? 'an unknown date'}, not on ${intent.departureDate}.`));
  }
  if (intent.returnDate) {
    if (plan.returnTransport && legDate(plan.returnTransport) !== intent.returnDate) {
      add(blocker('return_date', `The return journey leaves on ${legDate(plan.returnTransport) ?? 'an unknown date'}, not on ${intent.returnDate}.`));
    }
  } else if (plan.returnTransport) {
    add(blocker('return_unexpected', 'This is a one-way trip but the plan has a return journey.'));
  }

  // ---- accommodation --------------------------------------------------------
  const stay = plan.hotels[0];
  const party = Math.max(1, seatedTravelers(intent.travelers));
  if (stay) {
    if (stay.checkIn !== intent.departureDate || stay.checkOut !== intent.returnDate) {
      add(blocker('stay_dates', `The stay is for ${stay.checkIn} to ${stay.checkOut}, not for the trip dates.`));
    }
    const nights = nightsBetween(intent.departureDate, intent.returnDate);
    if (stay.nights !== nights) {
      add(blocker('stay_nights', `The stay is for ${stay.nights} night(s) but the trip has ${nights}.`));
    }
    const occupancy = stay.room.maxOccupancy;
    if (occupancy !== null && stay.rooms * occupancy < party) {
      add(blocker('stay_capacity', `${stay.rooms} room(s) sleeping ${occupancy} each cannot hold ${party} people.`));
    }
    const requiredRooms = findHard(constraints, 'required_rooms')?.value;
    if (typeof requiredRooms === 'number' && stay.rooms < requiredRooms) {
      add(blocker('stay_rooms', `You asked for ${requiredRooms} room(s) and this plan has ${stay.rooms}.`));
    }
    const minCategory = profile.accommodation.minCategory;
    if (minCategory && stay.hotel.category !== null && stay.hotel.category < minCategory) {
      add(blocker('stay_category', `The hotel is rated ${stay.hotel.category}, below the ${minCategory} you asked for.`));
    }
  }

  // ---- currency and provenance ------------------------------------------------
  const priced: Array<[string, Money | null]> = [
    ['total', plan.cost.total],
    ['outbound fare', plan.outboundTransport?.totalPrice ?? null],
    ['return fare', plan.returnTransport?.totalPrice ?? null],
    ['room price', stay?.room.totalPrice ?? null],
  ];
  for (const [label, amount] of priced) {
    if (amount && amount.currency !== SUPPORTED_CURRENCY) {
      add(blocker('currency', `The ${label} is in ${amount.currency}; only ${SUPPORTED_CURRENCY} is supported.`));
    }
  }
  const sources: Array<[string, { provenance: { provider: string } } | null]> = [
    ['outbound journey', plan.outboundTransport],
    ['return journey', plan.returnTransport],
    ['hotel', stay ? stay.hotel : null],
  ];
  for (const [label, item] of sources) {
    if (item && !item.provenance.provider) add(blocker('provenance', `The ${label} has no recorded source.`));
  }

  // ---- arithmetic ---------------------------------------------------------------
  const budget = assessBudget(plan, constraints);
  if (!budget.consistent) {
    add(blocker('cost_sum', 'The parts of the cost do not add up to the total shown.'));
  }
  if (stay && stay.room.totalPrice.currency === plan.cost.accommodation.currency) {
    const expected = multiply(stay.room.totalPrice, stay.rooms);
    if (!sameMoney(expected, plan.cost.accommodation)) {
      add(blocker('cost_stay', 'The accommodation cost does not match the room price and number of rooms.'));
    }
  }
  const fares = [plan.outboundTransport, plan.returnTransport].filter((o): o is TransportOffer => o !== null);
  const expectedFares = fares.reduce((sum, o) => sum + o.totalPrice.amount, 0);
  if (fares.every((o) => o.totalPrice.currency === plan.cost.transport.currency) && expectedFares !== plan.cost.transport.amount) {
    add(blocker('cost_transport', 'The transport cost does not match the fares of the chosen journeys.'));
  }

  // ---- budget ---------------------------------------------------------------------
  const engineAlreadyBlocked = plan.issues.some((i) => i.code === 'budget_exceeded' && i.severity === 'blocker');
  if (budget.status === 'over_firm' && !engineAlreadyBlocked) {
    add(blocker('budget_firm', 'This plan is over the limit you said not to exceed.'));
  }
  if (plan.cost.remainingBudget && budget.budget) {
    const expectedRemaining = budget.budget.amount - plan.cost.total.amount;
    if (plan.cost.remainingBudget.amount !== expectedRemaining) {
      add(blocker('budget_misreported', 'The amount left against the budget is not the budget minus the total.'));
    }
  }

  // ---- itinerary timing --------------------------------------------------------------
  const items = plan.days.flatMap((d) => d.items).filter((i) => i.kind !== 'rest');
  for (const item of items) {
    if (Date.parse(item.endUtc) <= Date.parse(item.startUtc)) {
      add(blocker('item_duration', `"${item.title}" ends before it starts.`, [item.id]));
    }
  }
  const ordered = [...items].sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]!;
    const item = ordered[i]!;
    if (Date.parse(item.startUtc) < Date.parse(prev.endUtc)) {
      add(blocker('overlap', `"${prev.title}" and "${item.title}" overlap.`, [prev.id, item.id]));
    }
  }

  // ---- leaving the hotel --------------------------------------------------------------------
  const checkOut = ordered.find((i) => i.kind === 'check_out');
  const homeward = plan.returnTransport ? ordered.filter((i) => i.kind === 'transport').at(-1) : undefined;
  if (checkOut && homeward && Date.parse(checkOut.endUtc) > Date.parse(homeward.startUtc)) {
    add(blocker('check_out_after_departure', 'Check-out is planned to finish after the journey home has left.', [checkOut.id, homeward.id]));
  }

  // ---- hard constraints -----------------------------------------------------------------
  const excluded = new Set(
    constraints.hard.filter((h) => h.kind === 'excluded_transport_mode').map((h) => String(h.value)),
  );
  for (const [label, offer] of [['outbound', plan.outboundTransport], ['return', plan.returnTransport]] as const) {
    if (offer && excluded.has(offer.mode)) {
      add(blocker('excluded_mode', `The ${label} journey is by ${offer.mode.replace('_', ' ')}, which you ruled out.`));
    }
  }

  // ---- parts the traveller asked to keep ----------------------------------------------------
  const kept = input.kept;
  if (kept?.outbound && plan.outboundTransport?.id !== kept.outbound.id) {
    add(blocker('pin_not_preserved', 'You asked to keep the outbound journey, but this plan changed it.'));
  }
  if (kept?.return && plan.returnTransport?.id !== kept.return.id) {
    add(blocker('pin_not_preserved', 'You asked to keep the return journey, but this plan changed it.'));
  }
  if (kept?.hotel && !(stay && stay.hotel.id === kept.hotel.hotel.id && stay.room.id === kept.hotel.room.id)) {
    add(blocker('pin_not_preserved', 'You asked to keep the hotel, but this plan changed it.'));
  }
  if (kept?.activities && !sameIds(plan.activities.map((x) => x.id), kept.activities.map((x) => x.id))) {
    add(blocker('pin_not_preserved', 'You asked to keep the things to do, but this plan changed them.'));
  }

  return found;
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);

/**
 * Validates every plan, adds this service's blockers to it, and re-ranks so
 * plans without a blocker come first. Never removes a plan and never edits a
 * price: a plan that fails stays visible, marked as not workable, with the
 * reasons on it.
 */
export function validatePlans(input: ValidationInput): ValidationReport {
  const results: PlanValidation[] = [];
  const plans = input.plans.map((plan) => {
    const added = validatePlan(plan, input);
    const blocked = plan.issues.some((i) => i.severity === 'blocker') || added.length > 0;
    results.push({ planId: plan.id, valid: !blocked, added });
    return added.length === 0 ? plan : { ...plan, issues: [...plan.issues, ...added] };
  });
  rankPlans(plans);
  return { plans, results, anyValid: results.some((r) => r.valid) };
}
