import {
  compare,
  formatMoney,
  multiply,
  priorityWeights,
  subtract,
  type ConstraintSet,
  type HotelOffer,
  type HotelRoomOffer,
  type Money,
  type PlanArchetype,
  type PlanChoice,
  type Priority,
  type SelectedHotel,
  type TransportOffer,
  type TravelStyle,
  type TravelerProfile,
} from '@trip/shared';
import { budgetCeiling } from './constraints.js';
import { knownTransportCost } from './pricing.js';
import { scoreTransportOffers } from './scoring.js';
import type { HotelSearchResult } from './hotels.js';
import type { TransportSearchResult } from './transport.js';

/**
 * Choosing among real options, deterministically and in the open.
 *
 * The search returns many transport options and many rooms. Which ones go into
 * a plan is decided here, by rules that can be read and repeated: the same
 * offers and the same traveller always give the same choice, and every choice
 * comes with the reason and with what was passed over. Nothing here asks a
 * model, and nothing here picks "the cheapest" by default: cheapest is one of
 * three readings of "best" (the Budget plan), and the others weigh time,
 * changes and comfort against price using what the traveller said matters.
 */

// ------------------------------------------------------------------- style

export type RoomTier = 'lowest' | 'value' | 'upper' | 'highest';

export interface StyleTargets {
  style: TravelStyle;
  /** The star rating the style points at when the traveller gave no minimum. */
  targetCategory: number | null;
  /** Which room to take in a property when its rooms differ in price. */
  roomTier: RoomTier;
}

const STYLE_TARGETS: Record<TravelStyle, Omit<StyleTargets, 'style'>> = {
  budget: { targetCategory: null, roomTier: 'lowest' },
  standard: { targetCategory: 3, roomTier: 'value' },
  premium: { targetCategory: 4, roomTier: 'upper' },
  luxury: { targetCategory: 5, roomTier: 'highest' },
};

export function styleTargets(profile: Pick<TravelerProfile, 'travelStyle'>): StyleTargets {
  const style = profile.travelStyle ?? 'standard';
  return { style, ...STYLE_TARGETS[style] };
}

/** What a style says matters, when the traveller has not ranked anything. */
const STYLE_PRIORITIES: Record<TravelStyle, Priority[]> = {
  budget: ['cheapest'],
  standard: ['cheapest', 'fastest'],
  premium: ['most_comfortable', 'fastest'],
  luxury: ['luxury', 'most_comfortable', 'fastest'],
};

/**
 * The ranking the scorers use. The traveller's own ranking always wins. With
 * none, a stated travel style stands in for one (so "luxury" is not scored as
 * if only the price mattered); with neither, the scorers keep their own
 * defaults. Asking for safety puts it first, whatever else was ranked.
 */
export function effectivePriorities(profile: TravelerProfile): Priority[] {
  const base: Priority[] =
    profile.priorities.length > 0
      ? profile.priorities
      : profile.travelStyle
        ? STYLE_PRIORITIES[profile.travelStyle]
        : [];
  if (!profile.special.safetyFirst) return base;
  return ['safest', ...base.filter((p) => p !== 'safest')];
}

export function withEffectivePriorities(profile: TravelerProfile): TravelerProfile {
  const priorities = effectivePriorities(profile);
  return priorities.length === profile.priorities.length && priorities.every((p, i) => p === profile.priorities[i])
    ? profile
    : { ...profile, priorities };
}

// --------------------------------------------------------------- transport

const MODE_NAME: Record<string, string> = {
  flight: 'Flight',
  train: 'Train',
  bus: 'Bus',
  self_drive: 'Driving your own car',
  rental_car: 'Rental car',
  taxi: 'Private car',
  ferry: 'Ferry',
};

/** Provider-supplied text is data: trimmed to a short line with control characters removed. */
export function cleanText(value: string, max = 60): string {
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function offerLabel(offer: TransportOffer): string {
  const first = offer.segments[0];
  const who = first?.operatorName ?? first?.serviceNumber ?? '';
  const at = first?.departureAt.slice(11, 16) ?? '';
  const name = MODE_NAME[offer.mode] ?? offer.mode;
  return cleanText(`${name}${who ? ` ${who}` : ''}${at ? ` leaving ${at}` : ''}`, 80);
}

const hours = (minutes: number) => `${Math.round((Math.abs(minutes) / 60) * 10) / 10}h`;

/** How an alternative compares with what was chosen, in words a traveller can check. */
function compareTransport(chosen: TransportOffer, other: TransportOffer): string {
  const money = compare(knownTransportCost(other), knownTransportCost(chosen));
  const minutes = other.totalDurationMinutes - chosen.totalDurationMinutes;
  const parts: string[] = [];
  if (money !== 0) {
    parts.push(
      `${formatMoney({ amount: Math.abs(money), currency: chosen.totalPrice.currency })} ${money > 0 ? 'more' : 'less'}`,
    );
  } else parts.push('the same price');
  if (Math.abs(minutes) >= 15) parts.push(`${hours(minutes)} ${minutes > 0 ? 'slower' : 'faster'}`);
  if (other.transfers !== chosen.transfers) {
    parts.push(other.transfers < chosen.transfers ? 'fewer changes' : 'more changes');
  }
  if (other.overnight && !chosen.overnight) parts.push('travels overnight');
  return parts.join(', ');
}

/** Every option found for one direction, best first for the reading of "best" the archetype stands for. */
export function rankTransport(
  search: TransportSearchResult,
  archetype: PlanArchetype,
  profile: TravelerProfile,
): TransportOffer[] {
  const every = search.modes.flatMap((m) => m.offers.map((o) => o.candidate));
  if (every.length === 0) return [];
  // A mode the traveller asked for narrows every reading of "best" to it when
  // it has options; otherwise all modes stay and the plans say why.
  const preferred = profile.transport.preferredMode;
  const pool = preferred && every.some((o) => o.mode === preferred) ? every.filter((o) => o.mode === preferred) : every;
  const byId = (a: TransportOffer, b: TransportOffer) => a.id.localeCompare(b.id);

  switch (archetype) {
    case 'budget':
      // Cheapest known cost; between equals, the quicker.
      return [...pool].sort(
        (a, b) =>
          compare(knownTransportCost(a), knownTransportCost(b)) ||
          a.totalDurationMinutes - b.totalDurationMinutes ||
          byId(a, b),
      );
    case 'comfort':
      // Fewest changes, then shortest time; between equals, the dearer fare (the better cabin).
      return [...pool].sort(
        (a, b) =>
          a.transfers - b.transfers ||
          a.totalDurationMinutes - b.totalDurationMinutes ||
          compare(knownTransportCost(b), knownTransportCost(a)) ||
          byId(a, b),
      );
    case 'balanced':
    default:
      return scoreTransportOffers(pool, withEffectivePriorities(profile)).map((s) => s.candidate);
  }
}

// ------------------------------------------------------------------ stays

export interface StayChoice {
  hotel: HotelOffer;
  room: HotelRoomOffer;
  /** Why this room in this property, in words. */
  roomWhy: string;
}

export interface RoomContext {
  archetype: PlanArchetype;
  profile: TravelerProfile;
  constraints: ConstraintSet;
  /** Rooms to book, and how many people sleep in them. */
  rooms: number;
  guests: number;
}

const ROOM_KINDS: Array<[RegExp, string]> = [
  [/\bsuite\b/i, 'suite'],
  [/\btwin\b/i, 'twin'],
  [/\b(?:double|king|queen)\b/i, 'double'],
  [/\bsingle\b/i, 'single'],
  [/\btriple\b/i, 'triple'],
  [/\bquad(?:ruple)?\b/i, 'quad'],
];

function roomKind(room: HotelRoomOffer): string | null {
  const text = `${room.roomType ?? ''} ${room.beds ?? ''} ${room.description}`;
  return ROOM_KINDS.find(([re]) => re.test(text))?.[1] ?? null;
}

function tierFor(ctx: RoomContext): RoomTier {
  if (ctx.archetype === 'budget') return 'lowest';
  if (ctx.archetype === 'comfort') return 'highest';
  return styleTargets(ctx.profile).roomTier;
}

/** How well a room fits what the traveller asked for, apart from its price. */
function fit(room: HotelRoomOffer, ctx: RoomContext): { score: number; matched: string[] } {
  const matched: string[] = [];
  const prefs = ctx.profile.accommodation;
  let score = 0;
  if (prefs.breakfastIncluded && room.breakfastIncluded === true) {
    score += 2;
    matched.push('includes breakfast');
  }
  if (prefs.roomType && roomKind(room) === (prefs.roomType === 'dorm_bed' ? 'single' : prefs.roomType)) {
    score += 2;
    matched.push(`is a ${prefs.roomType} room`);
  }
  if (effectivePriorities(ctx.profile).includes('flexible') && room.refundable === true) {
    score += 1;
    matched.push('can be cancelled');
  }
  return { score, matched };
}

/**
 * Which room to take in a property. Rooms that cannot sleep the party are set
 * aside when the property says how many each sleeps; among the rest, the ones
 * that fit the traveller's preferences best are kept, and the price tier the
 * plan stands for picks between them: cheapest for Budget, the best value for
 * a standard trip, the upper end for premium, the top for luxury and for the
 * Comfort plan (never above a ceiling the traveller set for accommodation).
 */
export function chooseRoom(hotel: HotelOffer, ctx: RoomContext): { room: HotelRoomOffer; why: string } {
  const fitsParty = hotel.rooms.filter((r) => r.maxOccupancy === null || r.maxOccupancy * ctx.rooms >= ctx.guests);
  const pool = fitsParty.length > 0 ? fitsParty : hotel.rooms;
  const scored = pool.map((room) => ({ room, ...fit(room, ctx) }));
  const best = Math.max(...scored.map((s) => s.score));
  const kept = scored
    .filter((s) => s.score === best)
    .sort((a, b) => compare(a.room.totalPrice, b.room.totalPrice) || a.room.id.localeCompare(b.room.id));

  const tier = tierFor(ctx);
  let pick = kept[0]!;
  let ceilingNote = '';
  if (tier === 'upper') pick = kept[Math.floor((kept.length - 1) * 0.66)]!;
  if (tier === 'highest') {
    // The top room, unless the traveller set a ceiling for the stay that it would break.
    const ceiling = budgetCeiling(ctx.constraints, 'accommodation') ?? ctx.constraints.budget.accommodation;
    const within = ceiling
      ? kept.filter((s) => s.room.totalPrice.currency === ceiling.currency && compare(multiply(s.room.totalPrice, ctx.rooms), ceiling) <= 0)
      : kept;
    pick = within.length > 0 ? within[within.length - 1]! : kept[0]!;
    if (ceiling && within.length < kept.length) ceilingNote = ' (the top rate would go past what you set aside for the stay)';
  }

  const alternatives = kept.length - 1;
  const fitNote = pick.matched.length > 0 ? ` It ${pick.matched.join(' and ')}.` : '';
  const why =
    tier === 'lowest'
      ? `The lowest rate here that suits your group${alternatives > 0 ? ` (${alternatives} dearer room${alternatives === 1 ? '' : 's'} not taken)` : ''}.${fitNote}`
      : tier === 'value'
        ? `The best value: the lowest rate among the rooms that suit your group.${fitNote}`
        : tier === 'upper'
          ? `An upper-tier room, as you asked for a premium trip.${fitNote}`
          : `The top room available${ceilingNote}, in keeping with a luxury or comfort-first plan.${fitNote}`;
  return { room: pick.room, why };
}

/** Every stay worth putting in a plan, best first for the reading of "best" the archetype stands for. */
export function rankStays(
  hotels: HotelSearchResult,
  archetype: PlanArchetype,
  ctx: Omit<RoomContext, 'archetype'>,
): StayChoice[] {
  const pool = hotels.candidates.map((c) => c.candidate);
  if (pool.length === 0) return [];
  const roomCtx: RoomContext = { ...ctx, archetype };
  const lowest = (h: HotelOffer) => h.rooms.reduce((min, r) => (compare(r.totalPrice, min) < 0 ? r.totalPrice : min), h.rooms[0]!.totalPrice);
  const distance = (h: HotelOffer) => hotels.distanceKm.get(h.id) ?? Infinity;

  let ordered: HotelOffer[];
  switch (archetype) {
    case 'budget':
      ordered = [...pool].sort((a, b) => compare(lowest(a), lowest(b)) || distance(a) - distance(b) || a.id.localeCompare(b.id));
      break;
    case 'comfort':
      // The highest rating; then the better-reviewed; then the closer; then the dearer (better) one.
      ordered = [...pool].sort(
        (a, b) =>
          (b.category ?? 0) - (a.category ?? 0) ||
          (b.guestRating ?? 0) - (a.guestRating ?? 0) ||
          distance(a) - distance(b) ||
          compare(lowest(b), lowest(a)) ||
          a.id.localeCompare(b.id),
      );
      break;
    case 'balanced':
    default:
      ordered = pool;
  }
  return ordered.map((hotel) => {
    const { room, why } = chooseRoom(hotel, roomCtx);
    return { hotel, room, roomWhy: why };
  });
}

// ---------------------------------------------------------- explaining it

const money = (m: Money) => formatMoney(m);

const ARCHETYPE_REASON: Record<PlanArchetype, string> = {
  budget: 'the lowest cost among the options that meet your requirements',
  balanced: 'the best fit for what you said matters most',
  comfort: 'the fewest changes and shortest time',
  custom: 'the best fit for your request',
};

function priorityNote(profile: TravelerProfile): string {
  const ranked = effectivePriorities(profile);
  if (ranked.length === 0) return 'price and time';
  const weights = priorityWeights(ranked);
  return [...weights.keys()]
    .slice(0, 3)
    .map((p) => p.replace(/_/g, ' '))
    .join(', then ');
}

/** The journey, why it was taken, and the best alternative in each other mode. */
export function explainTransport(
  topic: 'outbound' | 'return',
  chosen: TransportOffer,
  search: TransportSearchResult,
  archetype: PlanArchetype,
  profile: TravelerProfile,
  kept: boolean,
): PlanChoice {
  const others = search.modes
    .map((m) => [...m.offers].map((o) => o.candidate).filter((o) => o.id !== chosen.id))
    .filter((offers) => offers.length > 0)
    .map((offers) => [...offers].sort((a, b) => compare(knownTransportCost(a), knownTransportCost(b)))[0]!)
    .sort((a, b) => compare(knownTransportCost(a), knownTransportCost(b)))
    .slice(0, 3);
  const total = search.modes.reduce((n, m) => n + m.offers.length, 0);
  const why = kept
    ? 'Kept from your earlier plan, as you asked.'
    : archetype === 'balanced'
      ? `Chosen for ${priorityNote(profile)}, from ${total} option${total === 1 ? '' : 's'} that meet your requirements.`
      : `Chosen for ${ARCHETYPE_REASON[archetype]}, from ${total} option${total === 1 ? '' : 's'} that meet your requirements.`;
  return {
    topic,
    chosen: `${offerLabel(chosen)}, ${money(knownTransportCost(chosen))}`,
    why,
    alternatives: others.map((o) => ({ label: offerLabel(o), note: compareTransport(chosen, o) })),
  };
}

/** The stay and the room in it, why each was taken, and what else was close. */
export function explainStay(
  stay: SelectedHotel,
  hotels: HotelSearchResult,
  archetype: PlanArchetype,
  profile: TravelerProfile,
  roomWhy: string | null,
  kept: boolean,
): PlanChoice[] {
  const stayCost = multiply(stay.room.totalPrice, stay.rooms);
  const others = hotels.candidates
    .map((c) => c.candidate)
    .filter((h) => h.id !== stay.hotel.id)
    .slice(0, 3)
    .map((h) => {
      const cheapest = [...h.rooms].sort((a, b) => compare(a.totalPrice, b.totalPrice))[0]!;
      const cost = multiply(cheapest.totalPrice, stay.rooms);
      const diff = subtract(cost, stayCost);
      const km = hotels.distanceKm.get(h.id);
      const parts = [
        diff.amount === 0 ? 'the same price' : `${money({ amount: Math.abs(diff.amount), currency: diff.currency })} ${diff.amount > 0 ? 'more' : 'less'}`,
        h.category !== null ? `${h.category}-star` : null,
        km !== undefined ? `${km.toFixed(1)}km from your activities` : null,
      ].filter(Boolean);
      return { label: cleanText(h.name), note: parts.join(', ') };
    });
  const style = styleTargets(profile).style;
  const stayWhy = kept
    ? 'Kept from your earlier plan, as you asked.'
    : archetype === 'budget'
      ? 'The lowest-priced property that meets your requirements, counting the local travel its location adds.'
      : archetype === 'comfort'
        ? 'The highest-rated property that meets your requirements.'
        : `The best fit for a ${style} trip, weighing price against rating and how far it is from what you will be doing.`;
  const choices: PlanChoice[] = [
    {
      topic: 'stay',
      chosen: `${cleanText(stay.hotel.name)}${stay.hotel.category !== null ? ` (${stay.hotel.category}-star)` : ''}, ${stay.nights} night${stay.nights === 1 ? '' : 's'}, ${money(stayCost)}`,
      why: stayWhy,
      alternatives: others,
    },
  ];
  if (roomWhy && !kept) {
    choices.push({
      topic: 'room',
      chosen: `${cleanText(stay.room.description)} at ${money(stay.room.totalPrice)} a room for the stay`,
      why: roomWhy,
      alternatives: stay.hotel.rooms
        .filter((r) => r.id !== stay.room.id)
        .slice(0, 2)
        .map((r) => ({ label: cleanText(r.description), note: `${money(r.totalPrice)} a room for the stay` })),
    });
  }
  return choices;
}
