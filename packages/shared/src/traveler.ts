import { z } from 'zod';

export const TravelStyle = z.enum(['budget', 'standard', 'premium', 'luxury']);
export type TravelStyle = z.infer<typeof TravelStyle>;

export const TripPurpose = z.enum([
  'leisure',
  'business',
  'bleisure',
  'family_event',
  'pilgrimage',
]);
export type TripPurpose = z.infer<typeof TripPurpose>;

export const PartyType = z.enum(['solo', 'couple', 'family', 'friends', 'group', 'business_team']);
export type PartyType = z.infer<typeof PartyType>;

/**
 * Priorities are ranked, not weighted by the user. People are bad at assigning
 * numeric weights and good at ordering, so the engine converts the ordering
 * into weights (see `@trip/engine` scoring).
 */
export const Priority = z.enum([
  'cheapest',
  'fastest',
  'most_comfortable',
  'safest',
  'luxury',
  'family_friendly',
  'flexible',
  'scenic',
  'least_travel_time',
  'fewest_transfers',
]);
export type Priority = z.infer<typeof Priority>;

export const AccommodationType = z.enum([
  'hotel',
  'hostel',
  'resort',
  'villa',
  'apartment',
  'guesthouse',
  'homestay',
]);
export type AccommodationType = z.infer<typeof AccommodationType>;

export const RoomType = z.enum(['single', 'double', 'twin', 'triple', 'quad', 'suite', 'dorm_bed']);
export type RoomType = z.infer<typeof RoomType>;

export const CabinClass = z.enum(['economy', 'premium_economy', 'business', 'first']);
export type CabinClass = z.infer<typeof CabinClass>;

export const AccessibilityNeed = z.enum([
  'step_free_access',
  'wheelchair_accessible_room',
  'wheelchair_assistance_at_terminal',
  'accessible_bathroom',
  'elevator_required',
  'ground_floor_room',
  'service_animal',
  'visual_assistance',
  'hearing_assistance',
]);
export type AccessibilityNeed = z.infer<typeof AccessibilityNeed>;

export const DietaryRequirement = z.enum([
  'vegetarian',
  'vegan',
  'jain',
  'halal',
  'kosher',
  'gluten_free',
  'nut_allergy',
  'lactose_free',
  'diabetic',
]);
export type DietaryRequirement = z.infer<typeof DietaryRequirement>;

export const AccommodationPreferences = z.object({
  types: z.array(AccommodationType).default(['hotel']),
  minCategory: z.number().min(0).max(5).nullable().default(null),
  roomType: RoomType.nullable().default(null),
  rooms: z.number().int().min(1).max(20).default(1),
  bedsPerRoom: z.number().int().min(1).max(6).nullable().default(null),
  breakfastIncluded: z.boolean().nullable().default(null),
  privateBathroom: z.boolean().nullable().default(null),
  /** Free-text location intent, for example "near the old town". */
  locationPreference: z.string().nullable().default(null),
  /** Ceiling on transfer distance from the hotel to the planned activities. */
  maxDistanceToActivitiesKm: z.number().positive().nullable().default(null),
  freeCancellationRequired: z.boolean().default(false),
  amenities: z.array(z.string()).default([]),
});
export type AccommodationPreferences = z.infer<typeof AccommodationPreferences>;

export const TransportPreferences = z.object({
  cabinClass: CabinClass.nullable().default(null),
  preferredCarriers: z.array(z.string()).default([]),
  avoidedCarriers: z.array(z.string()).default([]),
  maxStops: z.number().int().min(0).max(3).nullable().default(null),
  avoidOvernightTravel: z.boolean().default(false),
  avoidRedEyeArrival: z.boolean().default(false),
  earliestDepartureLocal: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable()
    .default(null),
  latestArrivalLocal: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable()
    .default(null),
  checkedBagsPerTraveler: z.number().int().min(0).max(5).default(0),
  cabinBagsPerTraveler: z.number().int().min(0).max(3).default(1),
  /** Modes the traveller ruled out explicitly, for example "no buses". */
  excludedModes: z.array(z.string()).default([]),
  refundableRequired: z.boolean().default(false),
});
export type TransportPreferences = z.infer<typeof TransportPreferences>;

export const SpecialRequirements = z.object({
  accessibility: z.array(AccessibilityNeed).default([]),
  dietary: z.array(DietaryRequirement).default([]),
  travelingWithInfant: z.boolean().default(false),
  travelingWithElderly: z.boolean().default(false),
  /** Free-text notes the traveller added, passed to providers that support them. */
  assistanceNotes: z.array(z.string()).default([]),
  petsTraveling: z.boolean().default(false),
});
export type SpecialRequirements = z.infer<typeof SpecialRequirements>;

/**
 * Everything learned about the traveller through adaptive questioning. Every
 * field is optional until asked; `answeredKeys` records what has actually been
 * established, so the questioner never re-asks and never mistakes a schema
 * default for a stated preference.
 */
export const TravelerProfile = z.object({
  partyType: PartyType.nullable().default(null),
  purpose: TripPurpose.nullable().default(null),
  travelStyle: TravelStyle.nullable().default(null),
  /** Ranked, most important first. */
  priorities: z.array(Priority).default([]),
  accommodation: AccommodationPreferences.default({}),
  transport: TransportPreferences.default({}),
  special: SpecialRequirements.default({}),
  answeredKeys: z.array(z.string()).default([]),
  skippedKeys: z.array(z.string()).default([]),
});
export type TravelerProfile = z.infer<typeof TravelerProfile>;

export const emptyTravelerProfile = (): TravelerProfile => TravelerProfile.parse({});
