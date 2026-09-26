import { z } from 'zod';
import { Coordinates } from './geo.js';
import { Money } from './money.js';
import { TransportMode } from './trip.js';
import { ProviderProvenance } from './provider-result.js';

/**
 * Offer types are intentionally close to what providers actually return. Where
 * a provider does not supply a field, it stays `null` and the UI shows
 * "not provided by <provider>" rather than a plausible-looking guess.
 */

export const FareClass = z.object({
  /** The provider's own code, e.g. "3A" for Indian Railways AC 3-tier. */
  code: z.string(),
  /** The provider's own display label. Never normalised into invented tiers. */
  label: z.string(),
  /** Only set for air travel, where the four IATA cabins are well defined. */
  cabin: z.enum(['economy', 'premium_economy', 'business', 'first']).nullable().default(null),
  price: Money,
  /** Seats/berths the provider reports as available, when it reports any. */
  availability: z.number().int().nullable().default(null),
  availabilityLabel: z.string().nullable().default(null),
  refundable: z.boolean().nullable().default(null),
  /** Baggage as stated by the provider. Null means "provider did not say". */
  checkedBagsIncluded: z.number().int().nullable().default(null),
  cabinBagKg: z.number().nullable().default(null),
});
export type FareClass = z.infer<typeof FareClass>;

export const TransportSegment = z.object({
  mode: TransportMode,
  /** Carrier/operator code as given by the provider. */
  operatorCode: z.string().nullable().default(null),
  operatorName: z.string().nullable().default(null),
  /** Flight number, train number, bus service id. Never synthesised. */
  serviceNumber: z.string().nullable().default(null),
  origin: z.object({
    code: z.string().nullable().default(null),
    name: z.string(),
    coordinates: Coordinates.nullable().default(null),
    timezone: z.string().nullable().default(null),
    terminal: z.string().nullable().default(null),
  }),
  destination: z.object({
    code: z.string().nullable().default(null),
    name: z.string(),
    coordinates: Coordinates.nullable().default(null),
    timezone: z.string().nullable().default(null),
    terminal: z.string().nullable().default(null),
  }),
  /** Local departure/arrival with offset, exactly as the provider states it. */
  departureAt: z.string(),
  arrivalAt: z.string(),
  durationMinutes: z.number().int(),
  vehicleType: z.string().nullable().default(null),
});
export type TransportSegment = z.infer<typeof TransportSegment>;

export const TransportOffer = z.object({
  id: z.string(),
  mode: TransportMode,
  segments: z.array(TransportSegment).min(1),
  /**
   * The fare for all travellers in the search. A known amount: ₹0 for driving
   * your own car is a real fare of nothing, not a missing price. Separately
   * charged costs are in `itemisedFees`; costs nobody can price are named in
   * `unpricedCosts`.
   */
  totalPrice: Money,
  pricePerTraveler: Money,
  /**
   * Costs itemised separately from the fare: taxes, baggage, seat selection,
   * card fees, or the running cost of a drive. `included` means the amount is
   * already inside `totalPrice`; otherwise it is paid on top. `isEstimate`
   * marks a figure modelled from configuration rather than quoted, and
   * `basis` says what it was modelled from.
   */
  itemisedFees: z
    .array(
      z.object({
        label: z.string(),
        amount: Money,
        included: z.boolean(),
        isEstimate: z.boolean().default(false),
        basis: z.string().nullable().default(null),
      }),
    )
    .default([]),
  /**
   * Costs this option involves that no connected source can price, named for
   * the traveller, e.g. "Tolls". They are never counted as zero: they are
   * shown as "not calculated" and listed as not included in the total.
   */
  unpricedCosts: z.array(z.string()).default([]),
  fareClasses: z.array(FareClass).default([]),
  selectedFareCode: z.string().nullable().default(null),
  totalDurationMinutes: z.number().int(),
  transfers: z.number().int().min(0),
  /** True when any segment departs and arrives on different local dates. */
  overnight: z.boolean(),
  refundable: z.boolean().nullable().default(null),
  cancellationPolicy: z.string().nullable().default(null),
  baggageSummary: z.string().nullable().default(null),
  /** Everything needed to re-price this exact offer before booking. */
  revalidationToken: z.string().nullable().default(null),
  provenance: ProviderProvenance,
});
export type TransportOffer = z.infer<typeof TransportOffer>;

export const HotelRoomOffer = z.object({
  id: z.string(),
  description: z.string(),
  roomType: z.string().nullable().default(null),
  beds: z.string().nullable().default(null),
  maxOccupancy: z.number().int().nullable().default(null),
  boardType: z.string().nullable().default(null),
  breakfastIncluded: z.boolean().nullable().default(null),
  refundable: z.boolean().nullable().default(null),
  cancellationDeadline: z.string().nullable().default(null),
  cancellationPolicy: z.string().nullable().default(null),
  /** Price for the whole stay, for the room count requested. */
  totalPrice: Money,
  pricePerNight: Money,
  taxesIncluded: z.boolean().nullable().default(null),
  revalidationToken: z.string().nullable().default(null),
});
export type HotelRoomOffer = z.infer<typeof HotelRoomOffer>;

export const HotelOffer = z.object({
  id: z.string(),
  name: z.string(),
  propertyType: z.string().nullable().default(null),
  /** Star/category exactly as the provider reports it. Null when unrated. */
  category: z.number().nullable().default(null),
  guestRating: z.number().nullable().default(null),
  guestRatingCount: z.number().int().nullable().default(null),
  coordinates: Coordinates,
  address: z.string().nullable().default(null),
  neighbourhood: z.string().nullable().default(null),
  amenities: z.array(z.string()).default([]),
  checkInTime: z.string().nullable().default(null),
  checkOutTime: z.string().nullable().default(null),
  rooms: z.array(HotelRoomOffer).min(1),
  images: z.array(z.string().url()).default([]),
  provenance: ProviderProvenance,
});
export type HotelOffer = z.infer<typeof HotelOffer>;

export const TransferOffer = z.object({
  id: z.string(),
  mode: z.enum(['taxi', 'ride_hail', 'shuttle', 'public_transit', 'walk', 'rental_car', 'drive']),
  from: z.object({ name: z.string(), coordinates: Coordinates }),
  to: z.object({ name: z.string(), coordinates: Coordinates }),
  distanceKm: z.number(),
  durationMinutes: z.number().int(),
  /** How many vehicles the price is for: a party too big for one car needs more than one. */
  vehicles: z.number().int().min(1).default(1),
  /** Null when the provider only supplies routing, not pricing. */
  price: Money.nullable().default(null),
  priceIsEstimate: z.boolean().default(false),
  /** Where an estimate comes from, e.g. a configured per-km tariff. */
  estimateBasis: z.string().nullable().default(null),
  accessible: z.boolean().nullable().default(null),
  provenance: ProviderProvenance,
});
export type TransferOffer = z.infer<typeof TransferOffer>;

export const OpeningHours = z.object({
  /** 0 = Sunday. */
  weekday: z.number().int().min(0).max(6),
  opens: z.string(),
  closes: z.string(),
});
export type OpeningHours = z.infer<typeof OpeningHours>;

export const ActivityOffer = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  coordinates: Coordinates,
  address: z.string().nullable().default(null),
  /** Null when the source has no hours; the scheduler then flags it for checking. */
  openingHours: z.array(OpeningHours).nullable().default(null),
  typicalDurationMinutes: z.number().int().nullable().default(null),
  price: Money.nullable().default(null),
  priceIsEstimate: z.boolean().default(false),
  bookingRequired: z.boolean().nullable().default(null),
  rating: z.number().nullable().default(null),
  ratingCount: z.number().int().nullable().default(null),
  accessibility: z.array(z.string()).default([]),
  provenance: ProviderProvenance,
});
export type ActivityOffer = z.infer<typeof ActivityOffer>;
