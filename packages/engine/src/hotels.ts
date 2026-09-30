import type { ProviderRegistry } from '@trip/providers';
import {
  compare,
  findHard,
  haversineKm,
  multiply,
  nightsBetween,
  noteFromFailure,
  plannerNote,
  seatedTravelers,
  toMajor,
  type ActivityOffer,
  type ConstraintSet,
  type Coordinates,
  type HotelOffer,
  type Money,
  type ProviderNote,
  type SelectedHotel,
  type TravelerProfile,
  type TripIntent,
} from '@trip/shared';
import { describeNeeds, unconfirmedHotelNeeds } from './accessibility.js';
import { budgetCeiling } from './constraints.js';
import { keepSupportedHotels } from './currency.js';
import { sweepProviders } from './provider-calls.js';
import { chooseRoom, styleTargets, withEffectivePriorities } from './optimize.js';
import { scoreHotels, type ScoredCandidate } from './scoring.js';

/**
 * Accommodation search and selection.
 *
 * The central idea here is that a hotel's price is not its cost. A property is
 * chosen on what the whole stay costs the traveller: the room, plus the local
 * transport its location forces on every day of the trip. That is why the
 * search happens after activities are known, and why `impliedDailyTransportCost`
 * is computed per candidate before anything is ranked.
 */

export interface HotelSearchResult {
  candidates: ScoredCandidate<HotelOffer>[];
  selected: SelectedHotel | null;
  notes: ProviderNote[];
  filtered: Array<{ hotelId: string; reason: string }>;
  /** Distance from each candidate to the activity centroid, by hotel id. */
  distanceKm: Map<string, number>;
  /** Modelled local transport cost for the whole stay, by hotel id. */
  localTransportCost: Map<string, Money>;
}

export interface HotelSearchDeps {
  registry: ProviderRegistry;
  intent: TripIntent;
  profile: TravelerProfile;
  constraints: ConstraintSet;
  /** Where the traveller will actually spend their days. */
  activities: ActivityOffer[];
  /** Per-km cost used to model local transport. Null when no tariff exists. */
  localTransportPerKm: Money | null;
  /** Stops every provider call in the search when it fires. */
  signal?: AbortSignal;
}

/** The point the trip actually revolves around, used to bias the search. */
export function activityCentroid(
  activities: ActivityOffer[],
  fallback: Coordinates,
): Coordinates {
  if (activities.length === 0) return fallback;
  const sum = activities.reduce(
    (acc, a) => ({ lat: acc.lat + a.coordinates.lat, lon: acc.lon + a.coordinates.lon }),
    { lat: 0, lon: 0 },
  );
  return { lat: sum.lat / activities.length, lon: sum.lon / activities.length };
}

export async function searchHotels(deps: HotelSearchDeps): Promise<HotelSearchResult> {
  const { registry, intent, profile, constraints, activities } = deps;
  const nights = nightsBetween(intent.departureDate, intent.returnDate);
  if (nights === 0 || !intent.returnDate) {
    return { ...emptyResult(), notes: [] };
  }
  if (registry.hotels.length === 0) {
    const missing = registry.missingCapabilityNote('hotels', ['amadeus']);
    return { ...emptyResult(), notes: [noteFromFailure(missing, 'hotels')] };
  }

  const centre = activityCentroid(activities, intent.destination.coordinates);
  const accommodationBudget = budgetCeiling(constraints, 'accommodation');
  const maxPerNight = accommodationBudget
    ? Math.round(toMajor(accommodationBudget) / nights)
    : null;

  // Narrowed here, because a callback would not keep the check made above.
  const checkOut = intent.returnDate;
  const sweep = await sweepProviders(registry, registry.hotels, 'hotels', 'searchHotels', (provider) =>
    provider.searchHotels({
      destination: intent.destination,
      checkIn: intent.departureDate,
      checkOut,
      rooms: profile.accommodation.rooms,
      party: intent.travelers,
      minCategory: profile.accommodation.minCategory,
      maxPricePerNight: maxPerNight,
      currency: intent.currency,
      amenities: profile.accommodation.amenities,
      freeCancellationOnly: profile.accommodation.freeCancellationRequired,
      near: centre,
      radiusKm: profile.accommodation.maxDistanceToActivitiesKm ?? 15,
      limit: 30,
      ...(deps.signal ? { signal: deps.signal } : {}),
    }),
  );
  const offers: HotelOffer[] = sweep.data;
  const notes: ProviderNote[] = [...sweep.notes];

  // Currency first: nothing below may compare a rupee rate with another.
  const supported = keepSupportedHotels(offers);
  notes.push(...supported.notes);
  const { kept, filtered } = filterHotels(supported.kept, intent, profile, constraints, nights);

  const distanceKm = new Map<string, number>();
  const transportCost = new Map<string, Money>();
  for (const hotel of kept) {
    const km = haversineKm(hotel.coordinates, centre);
    distanceKm.set(hotel.id, Number(km.toFixed(2)));
    const modelled = modelLocalTransport(km, nights, deps.localTransportPerKm);
    if (modelled) transportCost.set(hotel.id, modelled);
  }

  // Scored on what the traveller ranked, or on what their travel style implies
  // when they ranked nothing, so a luxury trip is not scored on price alone.
  const candidates = scoreHotels(kept, {
    profile: withEffectivePriorities(profile),
    distanceKm,
    transportCost,
    targetCategory: styleTargets(profile).targetCategory,
  });
  const best = candidates[0]?.candidate ?? null;

  const selected: SelectedHotel | null = best
    ? {
        hotel: best,
        room: chooseRoom(best, {
          archetype: 'balanced',
          profile,
          constraints,
          rooms: profile.accommodation.rooms,
          guests: seatedTravelers(intent.travelers),
        }).room,
        rooms: profile.accommodation.rooms,
        checkIn: intent.departureDate,
        checkOut: intent.returnDate,
        nights,
        distanceToActivitiesKm: distanceKm.get(best.id) ?? null,
        impliedDailyTransportCost: deps.localTransportPerKm
          ? modelLocalTransport(distanceKm.get(best.id) ?? 0, 1, deps.localTransportPerKm)
          : null,
      }
    : null;

  if (!selected && offers.length > 0) {
    const found = `${offers.length} propert${offers.length === 1 ? 'y was' : 'ies were'} found but none met your requirements; the reason for each is listed.`;
    const accessibilityNeeds = findHard(constraints, 'required_accessibility')?.value ?? [];
    const byAccessibility = filtered.some((f) => f.reason.startsWith('Does not publish that it offers'));
    notes.push(
      plannerNote(
        byAccessibility
          ? `${found} Hotel providers rarely publish accessibility details, so properties that do not state ${describeNeeds(accessibilityNeeds)} were not included. Contacting properties directly is the most reliable way to confirm.`
          : `${found} Relaxing one of them, such as the star rating or cancellation policy, would open more options.`,
        'no_availability',
        'hotels',
      ),
    );
  }

  return { candidates, selected, notes, filtered, distanceKm, localTransportCost: transportCost };
}

function emptyResult(): HotelSearchResult {
  return {
    candidates: [],
    selected: null,
    notes: [],
    filtered: [],
    distanceKm: new Map(),
    localTransportCost: new Map(),
  };
}

/**
 * Two return trips a day to the middle of everything, for every night of the
 * stay. It is a model, not a quote, and the cost breakdown labels it as such;
 * what matters is that it is applied identically to every candidate, so the
 * comparison between them is fair.
 */
export function modelLocalTransport(
  distanceKm: number,
  nights: number,
  perKm: Money | null,
): Money | null {
  // With no tariff there is no basis for a figure. Unknown is not ₹0: the
  // hotel ranking then leaves local travel out for every property equally.
  if (!perKm) return null;
  const dailyKm = distanceKm * 4;
  return multiply(perKm, dailyKm * Math.max(1, nights));
}

function filterHotels(
  offers: HotelOffer[],
  intent: TripIntent,
  profile: TravelerProfile,
  constraints: ConstraintSet,
  nights: number,
): { kept: HotelOffer[]; filtered: Array<{ hotelId: string; reason: string }> } {
  const kept: HotelOffer[] = [];
  const filtered: Array<{ hotelId: string; reason: string }> = [];
  const requiredRooms = findHard(constraints, 'required_rooms')?.value ?? profile.accommodation.rooms;
  const needsFreeCancellation = Boolean(findHard(constraints, 'required_free_cancellation'));
  const accommodationBudget = budgetCeiling(constraints, 'accommodation');
  const minCategory = profile.accommodation.minCategory;
  const rooms = Math.max(1, requiredRooms);
  const guests = seatedTravelers(intent.travelers);

  const accessibilityNeeds = findHard(constraints, 'required_accessibility')?.value ?? [];

  for (const hotel of offers) {
    if (minCategory !== null && hotel.category !== null && hotel.category < minCategory) {
      filtered.push({
        hotelId: hotel.id,
        reason: `Rated ${hotel.category}; you asked for ${minCategory} or above.`,
      });
      continue;
    }

    // Accessibility is a hard requirement, so a property is only kept when
    // it publishes that it meets every stated need. Silence is not a yes.
    const unconfirmed = unconfirmedHotelNeeds(hotel, accessibilityNeeds);
    if (unconfirmed.length > 0) {
      filtered.push({
        hotelId: hotel.id,
        reason: `Does not publish that it offers ${describeNeeds(unconfirmed)}. This is missing information, not a statement that the property is inaccessible.`,
      });
      continue;
    }

    const usableRooms = hotel.rooms.filter((room) => {
      if (needsFreeCancellation && room.refundable !== true) return false;
      return true;
    });
    if (usableRooms.length === 0) {
      filtered.push({
        hotelId: hotel.id,
        reason: needsFreeCancellation
          ? 'No rate here offers free cancellation.'
          : 'No bookable rate was returned for this property.',
      });
      continue;
    }

    // Occupancy is a hard requirement: four people do not go into one double
    // just because the rate is attractive. It is checked room by room, so a
    // property whose cheapest room is too small is still kept for the larger
    // room it also has, and only dropped when none of its rooms will do.
    const sleepsParty = usableRooms.filter((r) => r.maxOccupancy === null || r.maxOccupancy * rooms >= guests);
    if (sleepsParty.length === 0) {
      const largest = Math.max(...usableRooms.map((r) => r.maxOccupancy ?? 0));
      filtered.push({
        hotelId: hotel.id,
        reason: `Rooms here sleep ${largest} at most, which is not enough for ${guests} guest(s) in ${rooms} room(s).`,
      });
      continue;
    }

    const cheapest = [...sleepsParty].sort((a, b) => compare(a.totalPrice, b.totalPrice))[0]!;
    if (accommodationBudget) {
      // A rate that cannot be compared with the budget cannot be shown to
      // meet it; skipping the check would quietly relax a hard constraint.
      if (cheapest.totalPrice.currency !== accommodationBudget.currency) {
        filtered.push({
          hotelId: hotel.id,
          reason: `Priced in ${cheapest.totalPrice.currency}, so it cannot be checked against your ${accommodationBudget.currency} budget.`,
        });
        continue;
      }
      // Every room booked is paid for, so it is the whole booking that has to fit.
      if (compare(multiply(cheapest.totalPrice, rooms), accommodationBudget) > 0) {
        filtered.push({
          hotelId: hotel.id,
          reason: `Cheapest rate for ${nights} night(s)${rooms > 1 ? ` in ${rooms} rooms` : ''} is more than your firm budget on its own.`,
        });
        continue;
      }
    }

    kept.push({ ...hotel, rooms: sleepsParty });
  }
  return { kept, filtered };
}

export function partySize(intent: TripIntent): number {
  return seatedTravelers(intent.travelers);
}
