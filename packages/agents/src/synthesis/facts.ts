import {
  formatMoney,
  type ConstraintSet,
  type FeasibilityReport,
  type ProviderNote,
  type RequirementsState,
  type TransportOffer,
  type TripIntent,
  type TripPlan,
} from '@trip/shared';
import { assessBudget, describeBudget } from '../budget-service.js';
import type { PlanValidation } from '../validation-service.js';
import { assertsTooMuch } from './fact-check.js';

/**
 * The facts the Synthesis Agent is allowed to talk about.
 *
 * Everything in here is a string built in code from the validated plan: a
 * figure is formatted by `formatMoney`, a time is copied from a segment, a
 * budget position comes from the budget service. The agent is handed these
 * strings and nothing else, and what it writes is checked against them, so an
 * explanation can only ever restate what the deterministic side established.
 */

export interface PlanFact {
  planId: string;
  label: string;
  /** No blocker of any origin: the plan can actually be carried out. */
  valid: boolean;
  /** Why it cannot, in words; empty when valid. */
  blockers: string[];
  warnings: string[];
  outbound: string | null;
  returnLeg: string | null;
  stay: string | null;
  total: string;
  perPerson: string;
  budget: string;
  tradeoffs: string[];
}

export interface SearchFacts {
  trip: string;
  plans: PlanFact[];
  /** The best plan that is valid, or null when none is. */
  recommendedPlanId: string | null;
  /** Kept parts that could not be kept, each with the reason. */
  pinsReleased: string[];
  /** Soft preferences the recommended plan does not meet. */
  unsatisfiedPreferences: string[];
  /** What guidance the agents contributed, in words. */
  guidance: string[];
  /** Why parts of the search came back empty. */
  notes: string[];
  /** What stands in the way of doing the trip as asked (blockers and warnings), from the planner's own checks. */
  feasibility: string[];
}

export interface FactsInput {
  intent: TripIntent;
  constraints: ConstraintSet;
  plans: TripPlan[];
  results: PlanValidation[];
  requirements: RequirementsState | null;
  pinsReleased: Array<{ component: string; reason: string }>;
  guidanceApplied: string[];
  providerNotes: ProviderNote[];
  feasibility?: FeasibilityReport | null;
}

/** Longest provider-supplied name repeated in an explanation. */
const MAX_NAME = 80;

const WITHHELD = 'A message from a provider was left out because it made a claim this planner cannot stand behind.';

/**
 * Provider-supplied text (a hotel's name, a carrier, a note) is data, not
 * something the planner says. It is cleaned, shortened, and left out entirely
 * if it asserts a link or a booking.
 */
export function safeText(value: string, fallback: string, max = MAX_NAME): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0 || assertsTooMuch(cleaned)) return fallback;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

const leg = (offer: TransportOffer | null): string | null => {
  const first = offer?.segments[0];
  const last = offer?.segments[offer.segments.length - 1];
  if (!offer || !first || !last) return null;
  const who = safeText(first.operatorName ?? '', offer.mode.replace('_', ' '), 40);
  return `${who} by ${offer.mode.replace('_', ' ')}, ${first.origin.code ?? first.origin.name} to ${last.destination.code ?? last.destination.name}, leaving ${first.departureAt.slice(0, 10)} at ${first.departureAt.slice(11, 16)}, fare ${formatMoney(offer.totalPrice)}`;
};

export function buildFacts(input: FactsInput): SearchFacts {
  const { intent } = input;
  const travellers = intent.travelers.adults + intent.travelers.children + intent.travelers.infants;

  const plans: PlanFact[] = input.plans.map((plan) => {
    const result = input.results.find((r) => r.planId === plan.id);
    const blockers = plan.issues.filter((i) => i.severity === 'blocker').map((i) => i.message);
    const stay = plan.hotels[0];
    return {
      planId: plan.id,
      label: plan.label,
      valid: result?.valid ?? blockers.length === 0,
      blockers: blockers.map((b) => safeText(b, WITHHELD, 300)),
      warnings: plan.issues.filter((i) => i.severity === 'warning').map((i) => safeText(i.message, WITHHELD, 300)),
      outbound: leg(plan.outboundTransport),
      returnLeg: leg(plan.returnTransport),
      stay: stay
        ? `${safeText(stay.hotel.name, 'a property whose name could not be shown')}${stay.hotel.category ? `, rated ${stay.hotel.category}` : ''}, ${stay.nights} night(s), ${stay.rooms} room(s), ${formatMoney(stay.room.totalPrice)} per room for the stay`
        : null,
      total: formatMoney(plan.cost.total),
      perPerson: formatMoney(plan.cost.perPerson),
      budget: describeBudget(assessBudget(plan, input.constraints)),
      tradeoffs: plan.tradeoffs.map((t) => safeText(t, WITHHELD, 300)),
    };
  });

  const recommended = plans.find((p) => p.valid) ?? null;
  const recommendedPlan = recommended ? input.plans.find((p) => p.id === recommended.planId) : undefined;

  return {
    trip: `${intent.origin.name} to ${intent.destination.name}, ${intent.departureDate}${intent.returnDate ? ` to ${intent.returnDate}` : ', one way'}, ${travellers} traveller(s)`,
    plans,
    recommendedPlanId: recommended?.planId ?? null,
    pinsReleased: input.pinsReleased.map((r) => `${r.component.replace('_', ' ')}: ${safeText(r.reason, WITHHELD, 300)}`),
    unsatisfiedPreferences: recommendedPlan ? unsatisfied(recommendedPlan, input.requirements) : [],
    guidance: input.guidanceApplied,
    notes: [...new Set(input.providerNotes.map((n) => safeText(n.message, WITHHELD, 300)))].slice(0, 8),
    feasibility: (input.feasibility?.findings ?? [])
      .filter((f) => f.severity !== 'info')
      .map((f) => safeText(f.message, WITHHELD, 400))
      .slice(0, 5),
  };
}

/**
 * Soft preferences the recommended plan visibly does not meet. Only things
 * that can be checked against the plan are checked; a preference that cannot
 * be verified is not reported as met or unmet.
 */
function unsatisfied(plan: TripPlan, requirements: RequirementsState | null): string[] {
  if (!requirements) return [];
  const out: string[] = [];
  for (const pref of requirements.soft) {
    if (pref.kind === 'preferred_mode' && plan.outboundTransport && plan.outboundTransport.mode !== pref.value) {
      out.push(`You would prefer to travel by ${pref.value.replace('_', ' ')}, but this plan travels by ${plan.outboundTransport.mode.replace('_', ' ')}.`);
    }
    if (pref.kind === 'amenity' && pref.value === 'breakfast' && plan.hotels[0] && plan.hotels[0].room.breakfastIncluded !== true) {
      out.push('You would like breakfast included, and this stay does not publish that it is.');
    }
    if (pref.kind === 'activity_interest' && plan.activities.length === 0) {
      out.push(`You are interested in ${pref.value}, but no things to do could be found for this plan.`);
    }
  }
  return [...new Set(out)];
}

/** Every number the facts contain, as a number, so a narrative can be checked against them. */
export function allowedNumbers(facts: SearchFacts): Set<number> {
  const text = JSON.stringify(facts);
  const out = new Set<number>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}
