import type { ProviderRegistry } from '@trip/providers';
import {
  compare,
  formatMoney,
  money,
  nightsBetween,
  type ActivityOffer,
  type ConstraintSet,
  type HotelOffer,
  type Money,
  type PlanArchetype,
  type ProviderNote,
  type SelectedHotel,
  type TransportOffer,
  type TravelerProfile,
  type TripIntent,
  type TripPlan,
} from '@trip/shared';
import { clusterByProximity, planActivities, type ActivityPlanResult } from './activities.js';
import { classifyJourney } from './classify.js';
import { computeCost, detectBudgetConflict, type BudgetConflict } from './cost.js';
import { searchHotels, modelLocalTransport, type HotelSearchResult } from './hotels.js';
import { knownTransportCost } from './pricing.js';
import { buildItinerary } from './schedule.js';
import { cheapestRoom, scoreTransportOffers } from './scoring.js';
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
  const { registry, intent, profile, constraints } = deps;
  const kept = deps.keep ?? {};
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
  const [outbound, inbound, activities] = await Promise.all([
    kept.outbound
      ? Promise.resolve(keptTransport('outbound', intent.departureDate, kept.outbound, profile))
      : searchTransport({ registry, intent, classification, profile, constraints }, 'outbound'),
    !intent.returnDate
      ? Promise.resolve(null)
      : kept.return
        ? Promise.resolve(keptTransport('return', intent.returnDate, kept.return, profile))
        : searchTransport({ registry, intent, classification, profile, constraints }, 'return'),
    kept.activities
      ? Promise.resolve<ActivityPlanResult>({
          activities: kept.activities,
          clusters: clusterByProximity(kept.activities, activityDays),
          notes: [],
        })
      : planActivities(registry, intent.destination, profile, activityDays, intent.currency),
  ]);

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
  const hotels = kept.hotel
    ? keptHotel(kept.hotel)
    : await searchHotels({
        registry,
        intent,
        profile,
        constraints,
        activities: activities.activities,
        localTransportPerKm,
      });
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
      notes.push({
        provider: 'engine',
        providerLabel: 'Planner',
        status: 'no_availability',
        message: `You asked to travel by ${preferred.replace('_', ' ')}, but no such option could be found for these dates, so the plans use other ways of travelling.`,
        occurredAt: new Date().toISOString(),
      });
    }
  }

  // One scoring pass over every outbound option, shared by all plans, so a
  // plan's score says how its journey compares with the alternatives.
  const outboundScores = scoreTransportOffers(
    outbound.modes.flatMap((m) => m.offers.map((o) => o.candidate)),
    profile,
  );
  const plans: TripPlan[] = [];
  const seen = new Set<string>();

  for (const archetype of ARCHETYPES) {
    const outboundOffer = pickTransport(outbound, archetype, profile);
    const inboundOffer = inbound ? pickTransport(inbound, archetype, profile) : null;
    const hotel = kept.hotel ?? pickHotel(hotels, archetype, intent, profile, localTransportPerKm, nights);

    // Nothing to plan with is not a plan. It is reported through the notes.
    if (!outboundOffer && !hotel) continue;

    const signature = `${outboundOffer?.id ?? 'none'}|${inboundOffer?.id ?? 'none'}|${hotel?.hotel.id ?? 'none'}`;
    if (seen.has(signature)) continue;
    seen.add(signature);

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
    const scored = outboundOffer
      ? outboundScores.find((s) => s.candidate.id === outboundOffer.id)
      : undefined;

    plans.push({
      id: `${archetype}-${signature.length.toString(36)}-${plans.length}`,
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
      priorityScore: scored?.score ?? 0.5,
      scoreBreakdown: scored?.breakdown ?? {},
      tradeoffs: buildTradeoffs(archetype, outboundOffer, hotel, outbound),
      providerNotes: [...notes, ...schedule.notes].map((n) => ({
        provider: n.provider,
        status: n.status,
        message: n.message,
      })),
      generatedAt: new Date().toISOString(),
    });
  }

  markMostExpensive(plans);

  // Ranked by how well each plan matches the traveller's own priorities, so
  // the order of the alternatives is itself an answer rather than a default.
  plans.sort((a, b) => b.priorityScore - a.priorityScore);

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

  return {
    plans,
    transport: { outbound, inbound },
    hotels,
    activities,
    notes,
    budgetConflict,
    decisionLog: log,
  };
}

/**
 * Archetype selection. Each one answers "best" differently, and each pulls
 * from the same pool of real offers, so the alternatives differ in substance
 * rather than in presentation.
 */
function pickTransport(
  search: TransportSearchResult,
  archetype: PlanArchetype,
  profile: TravelerProfile,
): TransportOffer | null {
  const every = search.modes.flatMap((m) => m.offers.map((o) => o.candidate));
  if (every.length === 0) return null;
  // A mode the traveller asked for narrows every archetype to it, when it
  // has options; otherwise all modes remain and the plans say why.
  const preferred = profile.transport.preferredMode;
  const all = preferred && every.some((o) => o.mode === preferred) ? every.filter((o) => o.mode === preferred) : every;

  switch (archetype) {
    case 'budget':
      return [...all].sort((a, b) => compare(knownTransportCost(a), knownTransportCost(b)))[0]!;
    case 'comfort': {
      // Comfort means the fewest changes, then the shortest time, then
      // whichever cabin the fare actually is. Price breaks ties last.
      const ranked = [...all].sort((a, b) => {
        if (a.transfers !== b.transfers) return a.transfers - b.transfers;
        if (a.totalDurationMinutes !== b.totalDurationMinutes) {
          return a.totalDurationMinutes - b.totalDurationMinutes;
        }
        return compare(knownTransportCost(b), knownTransportCost(a));
      });
      return ranked[0]!;
    }
    case 'balanced':
    default:
      return scoreTransportOffers(all, profile)[0]?.candidate ?? all[0]!;
  }
}

function pickHotel(
  hotels: HotelSearchResult,
  archetype: PlanArchetype,
  intent: TripIntent,
  profile: TravelerProfile,
  perKm: Money | null,
  nights: number,
): SelectedHotel | null {
  if (hotels.candidates.length === 0 || nights === 0 || !intent.returnDate) return null;
  const pool = hotels.candidates.map((c) => c.candidate);

  let chosen: HotelOffer;
  switch (archetype) {
    case 'budget':
      chosen = [...pool].sort((a, b) => compare(cheapestRoom(a).totalPrice, cheapestRoom(b).totalPrice))[0]!;
      break;
    case 'comfort':
      chosen = [...pool].sort((a, b) => (b.category ?? 0) - (a.category ?? 0))[0]!;
      break;
    case 'balanced':
    default:
      chosen = pool[0]!;
      break;
  }

  const distanceKm = hotels.distanceKm.get(chosen.id) ?? null;
  return {
    hotel: chosen,
    room: cheapestRoom(chosen),
    rooms: profile.accommodation.rooms,
    checkIn: intent.departureDate,
    checkOut: intent.returnDate,
    nights,
    distanceToActivitiesKm: distanceKm,
    // What this location costs per day in local travel: the figure that makes
    // a cheaper room in the wrong place visibly more expensive overall.
    impliedDailyTransportCost:
      perKm && distanceKm !== null
        ? modelLocalTransport(distanceKm, 1, perKm)
        : null,
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
    .map(([what, at]) => ({
      provider: 'engine',
      providerLabel: 'Planner',
      status: 'ok',
      message: `Kept from your earlier plan: the ${what}, with the price as retrieved on ${at.slice(0, 10)}. Prices can change after they are retrieved.`,
      occurredAt: new Date().toISOString(),
    }));
  if (kept.activities) {
    notes.push({
      provider: 'engine',
      providerLabel: 'Planner',
      status: 'ok',
      message: 'Kept from your earlier plan: the places to visit.',
      occurredAt: new Date().toISOString(),
    });
  }
  return notes;
}
