import type { ProviderRegistry } from '@trip/providers';
import {
  add,
  compare,
  formatMoney,
  hasWaiver,
  money,
  multiply,
  nightsBetween,
  plannerNote,
  seatedTravelers,
  type ActivityOffer,
  type ConstraintSet,
  type FeasibilityReport,
  type Money,
  type PlanArchetype,
  type PlanChoice,
  type ProviderNote,
  type SelectedHotel,
  type TransportOffer,
  type TravelerProfile,
  type TripIntent,
  type TripPlan,
} from '@trip/shared';
import {
  clusterByProximity,
  planActivities,
  type ActivityGuidance,
  type ActivityPlanResult,
} from './activities.js';
import { classifyJourney } from './classify.js';
import { computeCost, detectBudgetConflict, type BudgetConflict } from './cost.js';
import { analyseFeasibility } from './feasibility.js';
import { budgetOvershootFactor, combinePlanScore, rankPlans } from './plan-score.js';
import { searchHotels, modelLocalTransport, type HotelSearchResult } from './hotels.js';
import { explainStay, explainTransport, rankStays, rankTransport, withEffectivePriorities, type StayChoice } from './optimize.js';
import { knownTransportCost } from './pricing.js';
import { buildItinerary } from './schedule.js';
import { scoreTransportOffers } from './scoring.js';
import { searchTransport, type TransportSearchResult } from './transport.js';
import { validateItinerary } from './validate.js';

/**
 * Plan generation: the orchestration layer the rest of the engine serves.
 *
 * Rather than producing one itinerary and calling it the answer, this builds
 * several complete, validated plans from the same live search results, each
 * optimised for a different reading of "best". The traveller then chooses
 * between real alternatives with the trade-offs stated, instead of being
 * handed a single recommendation and asked to trust it.
 *
 * Searches happen once and are reused across archetypes. Running three full
 * provider sweeps to produce three plans would triple the cost and the
 * latency to tell the traveller very little more.
 */

export interface PlanGenerationDeps {
  registry: ProviderRegistry;
  intent: TripIntent;
  profile: TravelerProfile;
  constraints: ConstraintSet;
  /**
   * Parts of an earlier plan to keep exactly as they are. Each one replaces
   * its search entirely: the kept offer is used in every plan, with its
   * original provenance, so it is visibly the same item and not a new quote.
   */
  keep?: KeptComponents;
  /** Steers which things to do are searched for, and how many a day. Closed vocabulary only. */
  activityGuidance?: ActivityGuidance;
  /**
   * Stops the search when it fires: provider calls in flight are cancelled,
   * and nothing further is started. The search then rejects with the
   * signal's reason, and no partial plans are returned.
   */
  signal?: AbortSignal;
  /** Told where the search is, in words a traveller can read. */
  onProgress?: (progress: PlanProgress) => void;
}

export interface PlanProgress {
  /** A stable name for the step, for a client to key on. */
  step: 'classify' | 'guidance' | 'search' | 'hotels' | 'assemble' | 'rank' | 'validate' | 'explain';
  label: string;
  percent: number;
}

export interface KeptComponents {
  outbound?: TransportOffer | null;
  return?: TransportOffer | null;
  hotel?: SelectedHotel | null;
  activities?: ActivityOffer[] | null;
}

export interface PlanGenerationResult {
  plans: TripPlan[];
  transport: { outbound: TransportSearchResult; inbound: TransportSearchResult | null };
  hotels: HotelSearchResult;
  activities: ActivityPlanResult;
  notes: ProviderNote[];
  budgetConflict: BudgetConflict | null;
  /** Whether the trip can be done as asked, and what stands in the way when it cannot. */
  feasibility: FeasibilityReport;
  decisionLog: Array<{ at: string; step: string; detail: string }>;
}

const ARCHETYPES: PlanArchetype[] = ['budget', 'balanced', 'comfort'];

const ARCHETYPE_LABEL: Record<PlanArchetype, string> = {
  budget: 'Budget',
  balanced: 'Balanced',
  comfort: 'Comfort',
  custom: 'Your plan',
};

export async function generatePlans(deps: PlanGenerationDeps): Promise<PlanGenerationResult> {
  const { registry, intent, profile, constraints, signal } = deps;
  const kept = deps.keep ?? {};
  // Checked between steps, so a cancelled search stops at the next boundary
  // even where a provider ignores the signal.
  const checkpoint = () => signal?.throwIfAborted();
  const progress = (p: PlanProgress) => {
    checkpoint();
    deps.onProgress?.(p);
    // The listener may have cancelled the search.
    checkpoint();
  };
  progress({ step: 'classify', label: 'Understanding your trip', percent: 5 });
  const log: Array<{ at: string; step: string; detail: string }> = [];
  const note = (step: string, detail: string) =>
    log.push({ at: new Date().toISOString(), step, detail });

  const classification = classifyJourney(intent.origin, intent.destination, {
    excludedByTraveler: profile.transport.excludedModes as never,
  });
  note(
    'classify',
    `${classification.scope} journey, ${classification.greatCircleKm}km. Searching: ${classification.eligibleModes.join(', ') || 'nothing (all modes excluded)'}.`,
  );

  const nights = nightsBetween(intent.departureDate, intent.returnDate);

  // Transport and activities are independent, so they run together. Hotels
  // wait for activities, because where you will spend your days is an input
  // to where it makes sense to sleep.
  const activityDays = Math.max(0, nights - 1);
  progress({ step: 'search', label: 'Searching how to get there and what to do', percent: 15 });
  const [outbound, inbound, activities] = await Promise.all([
    kept.outbound
      ? Promise.resolve(keptTransport('outbound', intent.departureDate, kept.outbound, profile))
      : searchTransport({ registry, intent, classification, profile, constraints, ...(signal ? { signal } : {}) }, 'outbound'),
    !intent.returnDate
      ? Promise.resolve(null)
      : kept.return
        ? Promise.resolve(keptTransport('return', intent.returnDate, kept.return, profile))
        : searchTransport({ registry, intent, classification, profile, constraints, ...(signal ? { signal } : {}) }, 'return'),
    kept.activities
      ? Promise.resolve<ActivityPlanResult>({
          activities: kept.activities,
          clusters: clusterByProximity(kept.activities, activityDays),
          notes: [],
        })
      : planActivities(
          registry,
          intent.destination,
          profile,
          activityDays,
          intent.currency,
          signal,
          deps.activityGuidance,
        ),
  ]);
  checkpoint();

  const searchedModes = outbound.modes.filter((m) => m.offers.length > 0);
  note(
    'transport_search',
    searchedModes.length
      ? searchedModes
          .map(
            (m) =>
              `${m.mode}: ${m.offers.length} option(s), cheapest ${m.cheapest ? formatMoney(knownTransportCost(m.cheapest)) : 'n/a'}`,
          )
          .join('; ')
      : 'No transport options were returned by any connected provider.',
  );

  const localTransportPerKm = perKmRate(registry, intent.currency);

  /** Builds one complete plan from one combination of options: itinerary, cost, checks, score, explanation. */
  const assemble = async (combo: Combination, archetype: PlanArchetype): Promise<PlanDraft> => {
    const outboundOffer = combo.out;
    const inboundOffer = combo.back;
    const hotel = combo.stay?.selected ?? null;

    const schedule = await buildItinerary({
      registry,
      intent,
      classification,
      profile,
      outbound: outboundOffer,
      inbound: inboundOffer,
      hotel,
      clusters: activities.clusters,
      dailyMealBudget: constraints.budget.dailySpend,
    });

    const cost = computeCost({
      intent,
      items: schedule.items,
      outbound: outboundOffer,
      inbound: inboundOffer,
      hotel,
      constraints,
    });

    const issues = validateItinerary({
      intent,
      classification,
      profile,
      constraints,
      items: schedule.items,
      cost,
      outbound: outboundOffer,
      inbound: inboundOffer,
      hotel,
    });

    // Scored against every outbound option found, not on its own: the score
    // normalises each dimension between the best and worst candidate, and
    // with a single candidate every dimension came out as 1, so every plan
    // looked equally good on price, speed and changes.
    const journeyScore = outboundOffer
      ? outboundScores.find((sc) => sc.candidate.id === outboundOffer.id)
      : undefined;
    const stayScore = hotel ? hotels.candidates.find((c) => c.candidate.id === hotel.hotel.id) : undefined;
    const combined = combinePlanScore({ journey: journeyScore, stay: stayScore });
    const overshoot = budgetOvershootFactor(cost.total, constraints.budget.total, constraints.budget.firm);

    const choices: PlanChoice[] = [];
    if (outboundOffer) choices.push(explainTransport('outbound', outboundOffer, outbound, archetype, profile, Boolean(kept.outbound)));
    if (inboundOffer && inbound) choices.push(explainTransport('return', inboundOffer, inbound, archetype, profile, Boolean(kept.return)));
    if (hotel) choices.push(...explainStay(hotel, hotels, archetype, profile, combo.stay?.roomWhy ?? null, Boolean(combo.stay?.kept)));

    const plan: TripPlan = {
      id: `${archetype}-draft`,
      archetype,
      label: ARCHETYPE_LABEL[archetype],
      rationale: buildRationale(archetype, outboundOffer, hotel, cost.total),
      outboundTransport: outboundOffer,
      returnTransport: inboundOffer,
      hotels: hotel ? [hotel] : [],
      transfers: schedule.transfers,
      activities: schedule.scheduledActivities,
      days: schedule.days,
      cost,
      issues,
      priorityScore: Number((combined.score * overshoot).toFixed(4)),
      scoreBreakdown:
        overshoot < 1
          ? { ...combined.breakdown, over_budget_guide: Number((overshoot - 1).toFixed(4)) }
          : combined.breakdown,
      tradeoffs: buildTradeoffs(archetype, outboundOffer, hotel, outbound),
      choices,
      providerNotes: [...notes, ...schedule.notes].map((n) => ({
        provider: n.provider,
        ...(n.capability ? { capability: n.capability } : {}),
        status: n.status,
        message: n.message,
      })),
      generatedAt: new Date().toISOString(),
    };
    return { plan, cost, choices, outbound: outboundOffer, inbound: inboundOffer, hotel, scheduleNotes: schedule.notes };
  };
  progress({ step: 'hotels', label: 'Finding places to stay', percent: 55 });
  const hotels = kept.hotel
    ? keptHotel(kept.hotel)
    : await searchHotels({
        registry,
        intent,
        profile,
        constraints,
        activities: activities.activities,
        localTransportPerKm,
        ...(signal ? { signal } : {}),
      });
  checkpoint();
  note(
    'hotel_search',
    hotels.candidates.length
      ? `${hotels.candidates.length} propert(ies) met the hard requirements; ${hotels.filtered.length} were filtered out.`
      : 'No accommodation was available under the stated requirements.',
  );

  const notes: ProviderNote[] = [
    ...outbound.notes,
    ...(inbound?.notes ?? []),
    ...hotels.notes,
    ...activities.notes,
    ...keptNotes(kept),
  ];

  // "Use the train": every plan takes that mode where an option was found.
  // If none was, the plans use the best alternatives and say so.
  const preferred = profile.transport.preferredMode;
  if (preferred && !kept.outbound) {
    const found = outbound.modes.some((m) => m.mode === preferred && m.offers.length > 0);
    if (!found) {
      notes.push(
        plannerNote(
          `You asked to travel by ${preferred.replace('_', ' ')}, but no such option could be found for these dates, so the plans use other ways of travelling.`,
          'no_availability',
        ),
      );
    }
  }

  // One scoring pass over every outbound option, shared by all plans, so a
  // plan's score says how its journey compares with the alternatives.
  const scoring = withEffectivePriorities(profile);
  const outboundScores = scoreTransportOffers(
    outbound.modes.flatMap((m) => m.offers.map((o) => o.candidate)),
    scoring,
  );
  const plans: TripPlan[] = [];
  const seen = new Set<string>();
  const guests = seatedTravelers(intent.travelers);
  const firmTotal = firmTotalBudget(constraints);
  const otherRequirements = profile.special.otherRequirements;
  if (otherRequirements.length > 0) {
    notes.push(
      plannerNote(
        `You also asked for: ${otherRequirements.map((r) => `"${r}"`).join('; ')}. The planner cannot check this against its results, so it is listed for you to confirm rather than counted as met.`,
      ),
    );
  }

  for (const [index, archetype] of ARCHETYPES.entries()) {
    progress({
      step: 'assemble',
      label: 'Putting your plans together',
      percent: 70 + Math.round((index / ARCHETYPES.length) * 22),
    });

    // The options each reading of "best" would take, most preferred first.
    const outs: Array<TransportOffer | null> = kept.outbound
      ? [kept.outbound]
      : takeOrNone(rankTransport(outbound, archetype, profile), MAX_CANDIDATES.transport);
    const backs: Array<TransportOffer | null> = !inbound
      ? [null]
      : kept.return
        ? [kept.return]
        : takeOrNone(rankTransport(inbound, archetype, profile), MAX_CANDIDATES.transport);
    const stays: Array<StayPick | null> =
      nights === 0 || !intent.returnDate
        ? [null]
        : kept.hotel
          ? [{ selected: kept.hotel, roomWhy: null, kept: true }]
          : takeOrNone(
              rankStays(hotels, archetype, { profile, constraints, rooms: profile.accommodation.rooms, guests }).map((c) =>
                stayPick(c, hotels, intent, localTransportPerKm, nights, profile),
              ),
              MAX_CANDIDATES.stay,
            );

    // Every combination, the most preferred first. With no firm budget the
    // first one is the plan; with one, the first that fits it.
    const combos = rankedCombinations(outs, backs, stays).filter((c) => c.out || c.stay);
    let chosen: PlanDraft | null = null;
    let closest: PlanDraft | null = null;
    let skippedForPrice = 0;
    let overBudget = 0;
    let cheapestFloor: { combo: Combination; floor: number } | null = null;
    let builds = 0;

    for (const combo of combos) {
      checkpoint();
      if (firmTotal) {
        const floor = floorOf(combo, intent.currency);
        if (floor !== null && floor.amount > firmTotal.amount) {
          skippedForPrice += 1;
          if (!cheapestFloor || floor.amount < cheapestFloor.floor) cheapestFloor = { combo, floor: floor.amount };
          continue;
        }
      }
      const draft = await assemble(combo, archetype);
      builds += 1;
      if (!firmTotal || compare(draft.cost.total, firmTotal) <= 0) {
        chosen = draft;
        break;
      }
      overBudget += 1;
      if (!closest || draft.cost.total.amount < closest.cost.total.amount) closest = draft;
      if (builds >= MAX_BUDGET_BUILDS) break;
    }
    // Nothing fits a firm limit: show the closest, marked as over it by the
    // validator, rather than showing nothing or quietly loosening the limit.
    if (!chosen && closest) chosen = closest;
    if (!chosen && cheapestFloor) chosen = await assemble(cheapestFloor.combo, archetype);
    if (!chosen) continue;

    if (firmTotal && skippedForPrice + overBudget > 0) {
      chosen.choices.push({
        topic: 'budget',
        chosen: 'A less preferred combination',
        why: `More preferred combinations would have cost more than your firm limit of ${formatMoney(firmTotal)}, so the most preferred one that fits (or comes closest) was taken.`,
        alternatives: [],
      });
    }

    const signature = `${chosen.outbound?.id ?? 'none'}|${chosen.inbound?.id ?? 'none'}|${chosen.hotel?.hotel.id ?? 'none'}|${chosen.hotel?.room.id ?? 'none'}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    plans.push({ ...chosen.plan, id: `${archetype}-${signature.length.toString(36)}-${plans.length}` });
  }

  progress({ step: 'rank', label: 'Comparing your options', percent: 95 });
  markMostExpensive(plans);

  // Ranked by how well each plan matches the traveller's own priorities, so
  // the order of the alternatives is itself an answer rather than a default.
  rankPlans(plans);

  const primary = plans[0];
  const budgetConflict = primary
    ? detectBudgetConflict(primary.cost, constraints, {
        currentTransport: primary.outboundTransport,
        cheaperTransport: cheapestAcrossModes(outbound),
        hotel: primary.hotels[0] ?? null,
        hasActivities: primary.activities.length > 0,
      })
    : null;

  if (budgetConflict) {
    note(
      'budget_conflict',
      `Best plan is ${formatMoney(budgetConflict.overBy)} over the stated budget. ${budgetConflict.adjustments.length} adjustment(s) offered; none applied automatically.`,
    );
  }

  const feasibility = analyseFeasibility({
    intent,
    profile,
    constraints,
    outbound,
    inbound,
    hotels,
    nights,
    plans,
    kept: { outbound: Boolean(kept.outbound), return: Boolean(kept.return), hotel: Boolean(kept.hotel) },
  });
  note(
    'feasibility',
    `${feasibility.status}: ${feasibility.findings.length ? feasibility.findings.map((f) => f.code).join(', ') : 'no findings'}.`,
  );

  return {
    plans,
    transport: { outbound, inbound },
    hotels,
    activities,
    notes,
    budgetConflict,
    feasibility,
    decisionLog: log,
  };
}

// ---------------------------------------------------------------- selection

/** Options considered per part of the plan when fitting a firm budget. */
const MAX_CANDIDATES = { transport: 3, stay: 4 };
/** Most full itineraries built for one plan while looking for a combination inside a firm budget. */
const MAX_BUDGET_BUILDS = 4;

interface StayPick {
  selected: SelectedHotel;
  roomWhy: string | null;
  kept: boolean;
}

interface Combination {
  out: TransportOffer | null;
  back: TransportOffer | null;
  stay: StayPick | null;
  /** Position in each ranking, summed: lower is more preferred. */
  rank: number;
}

interface PlanDraft {
  plan: TripPlan;
  cost: TripPlan['cost'];
  choices: PlanChoice[];
  outbound: TransportOffer | null;
  inbound: TransportOffer | null;
  hotel: SelectedHotel | null;
  scheduleNotes: ProviderNote[];
}

const takeOrNone = <T>(items: T[], max: number): Array<T | null> => (items.length === 0 ? [null] : items.slice(0, max));

/** A total budget the traveller said must not be exceeded, and has not agreed to exceed. */
function firmTotalBudget(constraints: ConstraintSet): Money | null {
  const { total, firm } = constraints.budget;
  return total && firm && !hasWaiver(constraints, 'max_total_budget') ? total : null;
}

/** Every combination of the options, the most preferred first; ties keep each ranking's own order. */
function rankedCombinations(
  outs: Array<TransportOffer | null>,
  backs: Array<TransportOffer | null>,
  stays: Array<StayPick | null>,
): Combination[] {
  const combos: Array<Combination & { at: [number, number, number] }> = [];
  outs.forEach((out, i) =>
    backs.forEach((back, j) =>
      stays.forEach((stay, k) => combos.push({ out, back, stay, rank: i + j + k, at: [i, j, k] })),
    ),
  );
  return combos.sort((a, b) => a.rank - b.rank || a.at[0] - b.at[0] || a.at[1] - b.at[1] || a.at[2] - b.at[2]);
}

/** What a combination is known to cost before food and local travel: fares, fees and the rooms. Null if it cannot be added up. */
function floorOf(combo: Combination, currency: string): Money | null {
  const parts: Money[] = [];
  if (combo.out) parts.push(knownTransportCost(combo.out));
  if (combo.back) parts.push(knownTransportCost(combo.back));
  if (combo.stay) parts.push(multiply(combo.stay.selected.room.totalPrice, combo.stay.selected.rooms));
  if (parts.length === 0 || parts.some((p) => p.currency !== currency)) return null;
  return add(...parts);
}

/** A ranked stay as the plan's selected hotel, with what its location costs in local travel. */
function stayPick(
  choice: StayChoice,
  hotels: HotelSearchResult,
  intent: TripIntent,
  perKm: Money | null,
  nights: number,
  profile: TravelerProfile,
): StayPick {
  const distanceKm = hotels.distanceKm.get(choice.hotel.id) ?? null;
  return {
    roomWhy: choice.roomWhy,
    kept: false,
    selected: {
      hotel: choice.hotel,
      room: choice.room,
      rooms: profile.accommodation.rooms,
      checkIn: intent.departureDate,
      checkOut: intent.returnDate!,
      nights,
      distanceToActivitiesKm: distanceKm,
      // What this location costs per day in local travel: the figure that makes
      // a cheaper room in the wrong place visibly more expensive overall.
      impliedDailyTransportCost: perKm && distanceKm !== null ? modelLocalTransport(distanceKm, 1, perKm) : null,
    },
  };
}

function cheapestAcrossModes(search: TransportSearchResult): TransportOffer | null {
  const all = search.modes.map((m) => m.cheapest).filter((o): o is TransportOffer => o !== null);
  if (all.length === 0) return null;
  return [...all].sort((a, b) => compare(knownTransportCost(a), knownTransportCost(b)))[0]!;
}

function buildRationale(
  archetype: PlanArchetype,
  transport: TransportOffer | null,
  hotel: SelectedHotel | null,
  total: Money,
): string {
  const parts: string[] = [];
  if (transport) {
    const hours = Math.round((transport.totalDurationMinutes / 60) * 10) / 10;
    parts.push(
      `${transport.mode.replace('_', ' ')} each way, ${hours}h with ${transport.transfers} change(s)`,
    );
  }
  if (hotel) {
    parts.push(
      `${hotel.hotel.name}${hotel.hotel.category ? ` (${hotel.hotel.category}-star)` : ''} for ${hotel.nights} night(s)`,
    );
  }
  const shape =
    archetype === 'budget'
      ? 'Cheapest combination that still satisfies every requirement you set.'
      : archetype === 'comfort'
        ? 'Fewest changes and the highest-rated stay available within your requirements.'
        : 'The best balance of price, time and comfort against the priorities you ranked.';
  return `${shape} ${parts.join('; ')}. Estimated total ${formatMoney(total)}.`;
}

function buildTradeoffs(
  archetype: PlanArchetype,
  transport: TransportOffer | null,
  hotel: SelectedHotel | null,
  search: TransportSearchResult,
): string[] {
  const tradeoffs: string[] = [];
  const fastest = search.modes.map((m) => m.fastest).filter((o): o is TransportOffer => o !== null);
  const quickest = fastest.sort((a, b) => a.totalDurationMinutes - b.totalDurationMinutes)[0];

  if (transport && quickest && quickest.id !== transport.id) {
    const extraHours =
      Math.round(((transport.totalDurationMinutes - quickest.totalDurationMinutes) / 60) * 10) / 10;
    const extraCost = compare(knownTransportCost(quickest), knownTransportCost(transport));
    if (extraHours > 0) {
      tradeoffs.push(
        `About ${extraHours}h slower each way than the quickest option, which costs ${formatMoney(knownTransportCost(quickest))}${extraCost > 0 ? ' more' : ' less'}.`,
      );
    }
  }
  if (transport?.overnight) {
    tradeoffs.push('Includes an overnight leg, which saves a night of accommodation but not of sleep.');
  }
  // A total that leaves out costs nobody could price is lower than the truth, and
  // a cheap-looking option is the last place that should go unsaid.
  if (transport && transport.unpricedCosts.length > 0) {
    tradeoffs.push(
      `The cost of this journey is not fully known: ${transport.unpricedCosts.join(', ').toLowerCase()} could not be calculated, so it will cost more than shown.`,
    );
  }
  if (transport?.refundable === false) {
    tradeoffs.push('This fare is non-refundable.');
  }
  if (hotel && hotel.room.refundable === false) {
    tradeoffs.push('The room rate cannot be cancelled.');
  }
  if (archetype === 'budget' && hotel && hotel.hotel.category !== null) {
    tradeoffs.push(`Accommodation is ${hotel.hotel.category}-star.`);
  }
  return tradeoffs;
}

/**
 * Adds "most expensive" to the one plan it is true of, once every plan's
 * total is known. It used to be attached to the comfort plan
 * unconditionally, which was false whenever comfort was not the dearest.
 */
function markMostExpensive(plans: TripPlan[]): void {
  if (plans.length < 2) return;
  const totals = plans.map((p) => p.cost.total.amount);
  const highest = Math.max(...totals);
  if (totals.filter((t) => t === highest).length !== 1) return;
  plans[totals.indexOf(highest)]!.tradeoffs.push('This is the most expensive of the alternatives.');
}

/**
 * Per-km rate used to model local transport, taken from the operator's
 * configured taxi tariff. With no tariff configured the model returns nothing
 * rather than a number nobody can justify.
 */
function perKmRate(registry: ProviderRegistry, currency: string): Money | null {
  const perKm = registry.taxiTariffs[currency]?.perKm;
  return perKm === undefined ? null : money(perKm, currency);
}

// ---------------------------------------------------------------- kept parts

/**
 * A kept journey stands in for its whole search: the comparison shows it as
 * the only option for that direction, because nothing else was searched.
 */
function keptTransport(
  direction: 'outbound' | 'return',
  date: string,
  offer: TransportOffer,
  profile: TravelerProfile,
): TransportSearchResult {
  return {
    direction,
    date,
    modes: [
      {
        mode: offer.mode,
        offers: scoreTransportOffers([offer], profile),
        cheapest: offer,
        fastest: offer,
        bestForYou: offer,
        note: null,
        notes: [],
      },
    ],
    notes: [],
    filtered: [],
  };
}

function keptHotel(selected: SelectedHotel): HotelSearchResult {
  return {
    candidates: [{ candidate: selected.hotel, score: 1, breakdown: {} }],
    selected,
    notes: [],
    filtered: [],
    distanceKm: new Map(
      selected.distanceToActivitiesKm === null ? [] : [[selected.hotel.id, selected.distanceToActivitiesKm]],
    ),
    localTransportCost: new Map(),
  };
}

/**
 * Tells the traveller which parts were kept and when their prices were
 * retrieved: a kept price is the one quoted then, not a new quote.
 */
function keptNotes(kept: KeptComponents): ProviderNote[] {
  const items: Array<[string, string | undefined]> = [
    ['outbound journey', kept.outbound?.provenance.retrievedAt],
    ['return journey', kept.return?.provenance.retrievedAt],
    ['hotel', kept.hotel?.hotel.provenance.retrievedAt],
  ];
  const notes: ProviderNote[] = items
    .filter((i): i is [string, string] => i[1] !== undefined)
    .map(([what, at]) =>
      plannerNote(
        `Kept from your earlier plan: the ${what}, with the price as retrieved on ${at.slice(0, 10)}. Prices can change after they are retrieved.`,
      ),
    );
  // A quote its provider said would lapse, and has, is stale: say so rather than presenting it as current.
  const stale: Array<[string, string | null | undefined]> = [
    ['outbound journey', kept.outbound?.provenance.validUntil],
    ['return journey', kept.return?.provenance.validUntil],
    ['hotel', kept.hotel?.hotel.provenance.validUntil],
  ];
  for (const [what, until] of stale) {
    if (until && Date.parse(until) < Date.now()) {
      notes.push(
        plannerNote(
          `The kept ${what} was quoted with a price that was only valid until ${until.slice(0, 10)}. That has passed, so treat the price as out of date until it is searched again.`,
          'price_changed',
        ),
      );
    }
  }
  if (kept.activities) notes.push(plannerNote('Kept from your earlier plan: the places to visit.'));
  return notes;
}
