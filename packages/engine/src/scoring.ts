import {
  cabinClassRank,
  compare,
  priorityWeights,
  toMajor,
  type HotelOffer,
  type Money,
  type Priority,
  type TransportMode,
  type TransportOffer,
  type TravelerProfile,
} from '@trip/shared';
import { knownTransportCost } from './pricing.js';

/**
 * Scoring turns a ranked list of priorities into a number per candidate.
 *
 * Two rules keep this honest:
 *  - Every dimension is normalised against the actual candidate set, so a
 *    score is "best available for this search", never an absolute claim.
 *  - Nothing here invents facts. "Safest" does not consult an imaginary safety
 *    index; it scores properties of the itinerary itself (overnight arrival,
 *    number of changes, late-night transfers) and the UI states that basis.
 */

export interface ScoredCandidate<T> {
  candidate: T;
  score: number;
  /** Per-dimension contributions, shown to explain the ranking. */
  breakdown: Record<string, number>;
}

/** Normalise so the best value scores 1 and the worst 0. */
function normaliseLowerIsBetter(values: number[], value: number): number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return 1;
  return 1 - (value - min) / (max - min);
}

/** Comfort ordering across modes, used when the traveller ranks comfort. */
const MODE_COMFORT: Record<TransportMode, number> = {
  flight: 0.7,
  train: 0.75,
  bus: 0.35,
  self_drive: 0.6,
  rental_car: 0.65,
  taxi: 0.8,
  ferry: 0.5,
};

/** Modes where the journey itself is part of the trip. */
const MODE_SCENIC: Record<TransportMode, number> = {
  flight: 0.1,
  train: 0.9,
  bus: 0.5,
  self_drive: 0.95,
  rental_car: 0.9,
  taxi: 0.5,
  ferry: 0.9,
};

/** How well a mode suits travelling with young children or elderly relatives. */
const MODE_FAMILY: Record<TransportMode, number> = {
  flight: 0.6,
  train: 0.9,
  bus: 0.35,
  self_drive: 0.8,
  rental_car: 0.8,
  taxi: 0.85,
  ferry: 0.6,
};

function arrivalHour(offer: TransportOffer): number {
  const last = offer.segments[offer.segments.length - 1];
  if (!last) return 12;
  const m = /T(\d{2}):/.exec(last.arrivalAt);
  return m ? Number(m[1]) : 12;
}

/**
 * A late-night arrival in an unfamiliar place, with luggage and no onward
 * transport, is the single most common way an otherwise sensible itinerary
 * turns unpleasant. This scores that property of the plan; it says nothing
 * about the destination itself.
 */
function arrivalComfort(offer: TransportOffer): number {
  const hour = arrivalHour(offer);
  if (hour >= 7 && hour <= 20) return 1;
  if (hour > 20 && hour <= 23) return 0.5;
  return 0.15;
}

export function scoreTransportOffers(
  offers: TransportOffer[],
  profile: TravelerProfile,
): ScoredCandidate<TransportOffer>[] {
  if (offers.length === 0) return [];
  const weights = priorityWeights(
    profile.priorities.length ? profile.priorities : (['cheapest', 'fastest'] as Priority[]),
  );

  const prices = offers.map((o) => toMajor(knownTransportCost(o)));
  const durations = offers.map((o) => o.totalDurationMinutes);
  const transfers = offers.map((o) => o.transfers);

  return offers
    .map((offer) => {
      const dims: Record<string, number> = {
        cheapest: normaliseLowerIsBetter(prices, toMajor(knownTransportCost(offer))),
        fastest: normaliseLowerIsBetter(durations, offer.totalDurationMinutes),
        least_travel_time: normaliseLowerIsBetter(durations, offer.totalDurationMinutes),
        fewest_transfers: normaliseLowerIsBetter(transfers, offer.transfers),
        most_comfortable: comfortScore(offer, profile),
        luxury: comfortScore(offer, profile),
        safest: 0.5 * arrivalComfort(offer) + 0.5 * normaliseLowerIsBetter(transfers, offer.transfers),
        family_friendly:
          0.5 * (MODE_FAMILY[offer.mode] ?? 0.5) +
          0.3 * arrivalComfort(offer) +
          0.2 * normaliseLowerIsBetter(transfers, offer.transfers),
        flexible: offer.refundable === true ? 1 : offer.refundable === false ? 0.2 : 0.5,
        scenic: MODE_SCENIC[offer.mode] ?? 0.5,
      };

      let total = 0;
      let weightSum = 0;
      const breakdown: Record<string, number> = {};
      for (const [priority, weight] of weights) {
        const dim = dims[priority] ?? 0.5;
        breakdown[priority] = Number((dim * weight).toFixed(4));
        total += dim * weight;
        weightSum += weight;
      }

      // Avoiding overnight travel was stated as a preference, so it is applied
      // as a penalty rather than a filter: the option stays visible.
      if (profile.transport.avoidOvernightTravel && offer.overnight) {
        total *= 0.6;
        breakdown['overnight_penalty'] = -0.4;
      }

      return {
        candidate: offer,
        score: weightSum === 0 ? 0.5 : Number((total / weightSum).toFixed(4)),
        breakdown,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function comfortScore(offer: TransportOffer, profile: TravelerProfile): number {
  const base = MODE_COMFORT[offer.mode] ?? 0.5;
  const fare = offer.fareClasses.find((f) => f.code === offer.selectedFareCode) ?? offer.fareClasses[0];
  const cabinBonus = fare?.cabin ? cabinClassRank(fare.cabin) * 0.08 : 0;
  const wanted = profile.transport.cabinClass;
  const matchesWanted = wanted && fare?.cabin === wanted ? 0.1 : 0;
  const transferPenalty = Math.min(0.3, offer.transfers * 0.1);
  return clamp(base + cabinBonus + matchesWanted - transferPenalty);
}

export interface HotelScoringContext {
  profile: TravelerProfile;
  /** Distance from each hotel to the activity centroid, in km, by hotel id. */
  distanceKm: Map<string, number>;
  /** Modelled local transport cost for the whole stay, by hotel id. */
  transportCost: Map<string, Money>;
}

/**
 * Hotels are scored on the total cost of staying there, not the room rate.
 * A property 1,000 cheaper per night that adds 2,500 a day in taxis is worse,
 * and this is the function that knows it.
 */
export function scoreHotels(
  hotels: HotelOffer[],
  ctx: HotelScoringContext,
): ScoredCandidate<HotelOffer>[] {
  if (hotels.length === 0) return [];
  const weights = priorityWeights(
    ctx.profile.priorities.length ? ctx.profile.priorities : (['cheapest'] as Priority[]),
  );

  const effectiveCost = (h: HotelOffer): number => {
    const room = cheapestRoom(h);
    const transport = ctx.transportCost.get(h.id);
    return toMajor(room.totalPrice) + (transport ? toMajor(transport) : 0);
  };

  const costs = hotels.map(effectiveCost);
  const distances = hotels.map((h) => ctx.distanceKm.get(h.id) ?? 0);
  const wantedCategory = ctx.profile.accommodation.minCategory;

  return hotels
    .map((hotel) => {
      const room = cheapestRoom(hotel);
      const dims: Record<string, number> = {
        cheapest: normaliseLowerIsBetter(costs, effectiveCost(hotel)),
        fastest: normaliseLowerIsBetter(distances, ctx.distanceKm.get(hotel.id) ?? 0),
        least_travel_time: normaliseLowerIsBetter(distances, ctx.distanceKm.get(hotel.id) ?? 0),
        fewest_transfers: normaliseLowerIsBetter(distances, ctx.distanceKm.get(hotel.id) ?? 0),
        most_comfortable: categoryScore(hotel, wantedCategory),
        luxury: categoryScore(hotel, 5),
        // Guest ratings are real, published data; where a provider supplies
        // none, this dimension sits at neutral rather than penalising the
        // property for its provider's silence.
        safest: hotel.guestRating !== null ? clamp(hotel.guestRating / 10) : 0.5,
        family_friendly: familyScore(hotel, room.maxOccupancy),
        flexible: room.refundable === true ? 1 : room.refundable === false ? 0.2 : 0.5,
        scenic: 0.5,
      };

      let total = 0;
      let weightSum = 0;
      const breakdown: Record<string, number> = {};
      for (const [priority, weight] of weights) {
        const dim = dims[priority] ?? 0.5;
        breakdown[priority] = Number((dim * weight).toFixed(4));
        total += dim * weight;
        weightSum += weight;
      }
      if (ctx.profile.accommodation.breakfastIncluded && room.breakfastIncluded) {
        total *= 1.05;
        breakdown['breakfast_bonus'] = 0.05;
      }

      return {
        candidate: hotel,
        score: weightSum === 0 ? 0.5 : Number(clamp(total / weightSum).toFixed(4)),
        breakdown,
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function cheapestRoom(hotel: HotelOffer) {
  return [...hotel.rooms].sort((a, b) => compare(a.totalPrice, b.totalPrice))[0]!;
}

function categoryScore(hotel: HotelOffer, wanted: number | null): number {
  if (hotel.category === null) return 0.4;
  if (!wanted) return clamp(hotel.category / 5);
  return hotel.category >= wanted ? 1 : clamp(hotel.category / wanted) * 0.6;
}

function familyScore(hotel: HotelOffer, maxOccupancy: number | null): number {
  const amenities = hotel.amenities.map((a) => a.toLowerCase());
  let score = 0.5;
  if (amenities.some((a) => a.includes('kitchen'))) score += 0.15;
  if (amenities.some((a) => a.includes('pool'))) score += 0.1;
  if (maxOccupancy !== null && maxOccupancy >= 3) score += 0.15;
  return clamp(score);
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}
