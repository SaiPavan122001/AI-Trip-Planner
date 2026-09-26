import {
  add,
  compare,
  formatMoney,
  hasBlockers,
  multiply,
  seatedTravelers,
  statusClass,
  type ConstraintSet,
  type FeasibilityFinding,
  type FeasibilityReport,
  type Money,
  type ProviderNote,
  type TransportOffer,
  type TravelerProfile,
  type TripIntent,
  type TripPlan,
} from '@trip/shared';
import { cheapestRoom } from './scoring.js';
import { knownTransportCost } from './pricing.js';
import type { HotelSearchResult } from './hotels.js';
import type { TransportSearchResult } from './transport.js';

/**
 * Can this trip be done as asked, and if not, why not?
 *
 * The planner never quietly loosens something the traveller said. When the
 * requirements, the budget, the dates and what the providers returned cannot
 * all be met, this says which of them stands in the way, in numbers where
 * there are numbers, and what the traveller could relax. It reads what the
 * search found and changes nothing.
 */

export interface FeasibilityInput {
  intent: TripIntent;
  profile: TravelerProfile;
  constraints: ConstraintSet;
  outbound: TransportSearchResult;
  inbound: TransportSearchResult | null;
  hotels: HotelSearchResult;
  nights: number;
  plans: TripPlan[];
  /** Parts carried over from an earlier plan, which were not searched. */
  kept: { outbound: boolean; return: boolean; hotel: boolean };
}

const MODE_NAME: Record<string, string> = {
  flight: 'flights',
  train: 'trains',
  bus: 'buses',
  self_drive: 'driving',
  rental_car: 'a rental car',
  taxi: 'a private car',
  ferry: 'ferries',
};

const unique = (values: string[]) => [...new Set(values)];

function reasonsFor(filtered: Array<{ reason: string }>): string {
  return unique(filtered.map((f) => f.reason)).slice(0, 3).join(' ');
}

/** Where a direction stands: nothing found, and the honest reason. */
function transportFindings(
  direction: 'outward' | 'return',
  search: TransportSearchResult,
): FeasibilityFinding[] {
  const found = search.modes.reduce((n, m) => n + m.offers.length, 0);
  const which = direction === 'outward' ? 'the outward journey' : 'the journey home';
  const notes: ProviderNote[] = search.modes.flatMap((m) => m.notes);
  const trouble = search.modes.filter((m) => m.note && ['failed', 'timed_out', 'rate_limited', 'unusable'].includes(statusClass(m.note.status)));
  const out: FeasibilityFinding[] = [];

  if (found === 0) {
    if (search.filtered.length > 0) {
      out.push({
        code: `${direction}_excluded_by_requirements`,
        severity: 'blocker',
        message: `Options for ${which} were found, but every one was ruled out by your requirements. ${reasonsFor(search.filtered)}`,
        suggestions: ['Relax one of these requirements and search again. Nothing has been loosened for you.'],
      });
    } else if (search.modes.length > 0 && notes.length > 0 && search.modes.every((m) => m.note && statusClass(m.note.status) === 'not_available')) {
      out.push({
        code: `${direction}_not_searched`,
        severity: 'blocker',
        message: `Nothing was searched for ${which}: no provider is connected for ${unique(search.modes.map((m) => MODE_NAME[m.mode] ?? m.mode)).slice(0, 4).join(', ')}.`,
        suggestions: ['Connect a provider for at least one way of travelling (see docs/providers.md).'],
      });
    } else if (trouble.length > 0) {
      out.push({
        code: `${direction}_providers_failed`,
        severity: 'blocker',
        message: `No option for ${which} could be shown, and a source did not answer properly (${unique(trouble.map((m) => `${MODE_NAME[m.mode] ?? m.mode}: ${m.note!.message}`)).join(' ')}) so options may exist that could not be seen.`,
        suggestions: ['Try again in a few minutes.'],
      });
    } else {
      out.push({
        code: `${direction}_none_found`,
        severity: 'blocker',
        message: `No option was found for ${which} on ${search.date}.`,
        suggestions: ['Try a different date, or a different way of travelling.'],
      });
    }
    return out;
  }

  if (trouble.length > 0) {
    out.push({
      code: `${direction}_incomplete`,
      severity: 'warning',
      message: `The comparison for ${which} may be missing options: ${unique(trouble.map((m) => `${MODE_NAME[m.mode] ?? m.mode} could not be searched (${m.note!.message})`)).join(' ')}`,
      suggestions: ['Search again later to include them.'],
    });
  }
  return out;
}

const cheapestOffer = (search: TransportSearchResult): TransportOffer | null => {
  const all = search.modes.flatMap((m) => m.offers.map((o) => o.candidate));
  return all.length === 0 ? null : [...all].sort((a, b) => compare(knownTransportCost(a), knownTransportCost(b)))[0]!;
};

export function analyseFeasibility(input: FeasibilityInput): FeasibilityReport {
  const { intent, profile, constraints, outbound, inbound, hotels, nights, plans, kept } = input;
  const findings: FeasibilityFinding[] = [];

  if (!kept.outbound) findings.push(...transportFindings('outward', outbound));
  if (inbound && !kept.return) findings.push(...transportFindings('return', inbound));

  // ---- the stay --------------------------------------------------------------
  if (nights > 0 && !kept.hotel && hotels.candidates.length === 0) {
    const stayNotes = hotels.notes.filter((n) => n.capability === 'hotels');
    const classes = stayNotes.map((n) => statusClass(n.status));
    if (hotels.filtered.length > 0) {
      findings.push({
        code: 'stay_excluded_by_requirements',
        severity: 'blocker',
        message: `Places to stay were found, but every one was ruled out by your requirements. ${reasonsFor(hotels.filtered.map((f) => ({ reason: f.reason })))}`,
        suggestions: ['Relax one of these, such as the star rating, the cancellation policy or the budget for the stay.'],
      });
    } else if (classes.length > 0 && classes.every((c) => c === 'not_available')) {
      findings.push({
        code: 'stay_not_searched',
        severity: 'blocker',
        message: 'Accommodation was not searched: no hotel provider is connected.',
        suggestions: ['Connect a hotel provider (see docs/providers.md).'],
      });
    } else if (classes.some((c) => ['failed', 'timed_out', 'rate_limited', 'unusable'].includes(c))) {
      findings.push({
        code: 'stay_search_failed',
        severity: 'blocker',
        message: `Accommodation could not be searched properly (${unique(stayNotes.map((n) => n.message)).join(' ')}), so rooms may exist that could not be seen.`,
        suggestions: ['Try again in a few minutes.'],
      });
    } else {
      findings.push({
        code: 'no_stay_found',
        severity: 'blocker',
        message: `No rooms were found for ${intent.departureDate} to ${intent.returnDate ?? ''} in this area for your group.`,
        suggestions: ['Try different dates or a wider area.'],
      });
    }
  }

  // ---- the budget, against what actually exists -------------------------------
  const budget = constraints.budget.total;
  const cheapOut = kept.outbound ? null : cheapestOffer(outbound);
  const cheapBack = inbound && !kept.return ? cheapestOffer(inbound) : null;
  const cheapStay = hotels.candidates.length > 0 && !kept.hotel
    ? [...hotels.candidates.map((c) => cheapestRoom(c.candidate).totalPrice)].sort((a, b) => compare(a, b))[0]!
    : null;
  if (budget && cheapOut && (inbound === null || cheapBack) && (nights === 0 || cheapStay) && budget.currency === cheapOut.totalPrice.currency) {
    const parts: Money[] = [knownTransportCost(cheapOut)];
    if (cheapBack) parts.push(knownTransportCost(cheapBack));
    if (cheapStay) parts.push(multiply(cheapStay, profile.accommodation.rooms));
    const floor = add(...parts);
    if (compare(floor, budget) > 0) {
      const firm = constraints.budget.firm;
      findings.push({
        code: 'budget_below_cheapest_plan',
        severity: firm ? 'blocker' : 'warning',
        message: `The cheapest journey${cheapBack ? 's' : ''} and stay found cost ${formatMoney(floor)} together, which is ${formatMoney({ amount: floor.amount - budget.amount, currency: floor.currency })} above your ${firm ? 'firm limit' : 'budget'} of ${formatMoney(budget)}, before any food, local travel or activities.`,
        suggestions: [
          `Raise the budget to at least ${formatMoney(floor)}, plus something for food and getting around.`,
          'Shorten the trip, or try different dates when fares and rooms are cheaper.',
        ],
      });
    }
  }
  if (constraints.budget.firm && plans.length > 0 && plans.every((p) => p.issues.some((i) => i.code === 'budget_exceeded' && i.severity === 'blocker'))) {
    findings.push({
      code: 'firm_budget_not_met',
      severity: 'blocker',
      message: `No plan fits your firm limit of ${formatMoney(budget!)}. The plans are shown with what they cost so you can see by how much.`,
      suggestions: ['Raise the limit, or say it is a guide and the planner will rank plans by cost instead of ruling them out.'],
    });
  }

  // ---- the group ----------------------------------------------------------------
  const guests = seatedTravelers(intent.travelers);
  const stay = plans[0]?.hotels[0];
  if (stay && stay.room.maxOccupancy === null && guests > profile.accommodation.rooms * 2) {
    findings.push({
      code: 'rooms_may_be_short',
      severity: 'warning',
      message: `${guests} guests in ${profile.accommodation.rooms} room${profile.accommodation.rooms === 1 ? '' : 's'}: the provider does not say how many each room sleeps, and a typical room sleeps two.`,
      suggestions: ['Add rooms, or confirm with the property that the room sleeps your group.'],
    });
  }
  if (plans.length > 0 && plans.every((p) => p.outboundTransport?.mode === 'self_drive') && guests > 5) {
    findings.push({
      code: 'own_car_too_small',
      severity: 'warning',
      message: `Driving your own car is the only way of travelling in these plans, and ${guests} people is more than a car usually carries.`,
      suggestions: ['Use two vehicles, or look at other ways of travelling.'],
    });
  }

  const usable = plans.filter((p) => !hasBlockers(p));
  const blockers = findings.some((f) => f.severity === 'blocker');
  const status: FeasibilityReport['status'] =
    plans.length === 0
      ? 'infeasible'
      : blockers || usable.length === 0 || findings.some((f) => f.severity === 'warning')
        ? 'partial'
        : 'feasible';
  if (plans.length === 0 && findings.length === 0) {
    findings.push({
      code: 'nothing_to_plan',
      severity: 'blocker',
      message: 'There was nothing to build a plan from: no transport and no accommodation could be found for this trip.',
      suggestions: ['Check the places and dates, and that at least one provider is connected.'],
    });
  }
  return { status, findings };
}
