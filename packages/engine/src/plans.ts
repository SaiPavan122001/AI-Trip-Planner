import type { ProviderRegistry } from '@trip/providers';
import {
  compare,
  formatMoney,
  money,
  nightsBetween,
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
import { planActivities, type ActivityPlanResult } from './activities.js';
import { classifyJourney } from './classify.js';
import { computeCost, detectBudgetConflict, type BudgetConflict } from './cost.js';
import { searchHotels, modelLocalTransport, type HotelSearchResult } from './hotels.js';
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
  const [outbound, inbound, activities] = await Promise.all([
    searchTransport({ registry, intent, classification, profile, constraints }, 'outbound'),
    intent.returnDate
      ? searchTransport({ registry, intent, classification, profile, constraints }, 'return')
      : Promise.resolve(null),
    planActivities(registry, intent.destination, profile, Math.max(0, nights - 1), intent.currency),
  ]);

  const searchedModes = outbound.modes.filter((m) => m.offers.length > 0);
  note(
    'transport_search',
    searchedModes.length
      ? searchedModes
          .map(
            (m) =>
              `${m.mode}: ${m.offers.length} option(s), cheapest ${m.cheapest ? formatMoney(m.cheapest.totalPrice) : 'n/a'}`,
          )
          .join('; ')
      : 'No transport options were returned by any connected provider.',
  );

  const localTransportPerKm = perKmRate(registry, intent.currency);
  const hotels = await searchHotels({
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
  ];

  const plans: TripPlan[] = [];
  const seen = new Set<string>();

  for (const archetype of ARCHETYPES) {
    const outboundOffer = pickTransport(outbound, archetype, profile);
    const inboundOffer = inbound ? pickTransport(inbound, archetype, profile) : null;
    const hotel = pickHotel(hotels, archetype, intent, profile, localTransportPerKm, nights);

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

    const scored = outboundOffer
      ? scoreTransportOffers([outboundOffer], profile)[0]
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
  const all = search.modes.flatMap((m) => m.offers.map((o) => o.candidate));
  if (all.length === 0) return null;

  switch (archetype) {
    case 'budget':
      return [...all].sort((a, b) => compare(a.totalPrice, b.totalPrice))[0]!;
    case 'comfort': {
      // Comfort means the fewest changes, then the shortest time, then
      // whichever cabin the fare actually is. Price breaks ties last.
      const ranked = [...all].sort((a, b) => {
        if (a.transfers !== b.transfers) return a.transfers - b.transfers;
        if (a.totalDurationMinutes !== b.totalDurationMinutes) {
          return a.totalDurationMinutes - b.totalDurationMinutes;
        }
        return compare(b.totalPrice, a.totalPrice);
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
        ? modelLocalTransport(distanceKm, 1, perKm, intent.currency)
        : null,
  };
}

function cheapestAcrossModes(search: TransportSearchResult): TransportOffer | null {
  const all = search.modes.map((m) => m.cheapest).filter((o): o is TransportOffer => o !== null);
  if (all.length === 0) return null;
  return [...all].sort((a, b) => compare(a.totalPrice, b.totalPrice))[0]!;
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
    const extraCost = compare(quickest.totalPrice, transport.totalPrice);
    if (extraHours > 0) {
      tradeoffs.push(
        `About ${extraHours}h slower each way than the quickest option, which costs ${formatMoney(quickest.totalPrice)}${extraCost > 0 ? ' more' : ' less'}.`,
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
  if (archetype === 'comfort') {
    tradeoffs.push('This is the most expensive of the alternatives.');
  }
  return tradeoffs;
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
