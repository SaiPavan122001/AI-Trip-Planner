import { z } from 'zod';
import { Money } from './money.js';
import { ActivityOffer, HotelOffer, HotelRoomOffer, TransferOffer, TransportOffer } from './offers.js';
import { IsoDate } from './trip.js';

/**
 * An itinerary is a fully time-ordered chain of items. Every item carries an
 * absolute start/end instant plus the local timezone it happens in, which is
 * what makes cross-timezone validation possible at all.
 */

export const ItineraryItemKind = z.enum([
  'transport',
  'transfer',
  'check_in',
  'check_out',
  'stay',
  'activity',
  'meal',
  'rest',
  'buffer',
]);
export type ItineraryItemKind = z.infer<typeof ItineraryItemKind>;

export const ItineraryItem = z.object({
  id: z.string(),
  kind: ItineraryItemKind,
  title: z.string(),
  description: z.string().nullable().default(null),
  /** Absolute instants in UTC. The source of truth for all validation. */
  startUtc: z.string().datetime(),
  endUtc: z.string().datetime(),
  /** IANA zone used to render local times to the traveller. */
  timezone: z.string(),
  locationName: z.string().nullable().default(null),
  cost: Money.nullable().default(null),
  costIsEstimate: z.boolean().default(false),
  /** Links back to the offer this item came from, for revalidation. */
  offerRef: z
    .object({ kind: z.enum(['transport', 'hotel', 'transfer', 'activity']), offerId: z.string() })
    .nullable()
    .default(null),
  notes: z.array(z.string()).default([]),
});
export type ItineraryItem = z.infer<typeof ItineraryItem>;

export const ItineraryDay = z.object({
  date: IsoDate,
  /** The zone the traveller is in for most of this day. */
  timezone: z.string(),
  items: z.array(ItineraryItem),
  /** Sum of item costs attributed to this day. */
  daySubtotal: Money,
});
export type ItineraryDay = z.infer<typeof ItineraryDay>;

export const CostBreakdown = z.object({
  transport: Money,
  transportFees: Money,
  accommodation: Money,
  localTransport: Money,
  activities: Money,
  meals: Money,
  other: Money,
  total: Money,
  perPerson: Money,
  /** Portion of `total` that is an estimate rather than a quoted provider price. */
  estimatedPortion: Money,
  /**
   * Costs the plan involves that `total` does not include, because no source
   * can price them. The total is only complete when this is empty, and the
   * UI says so; an unknown cost is never counted as zero.
   */
  notIncluded: z
    .array(z.object({ label: z.string(), reason: z.string() }))
    .default([]),
  /** Positive when under budget, negative when over. Null with no budget set. */
  remainingBudget: Money.nullable().default(null),
});
export type CostBreakdown = z.infer<typeof CostBreakdown>;

export const ValidationSeverity = z.enum(['blocker', 'warning', 'info']);
export type ValidationSeverity = z.infer<typeof ValidationSeverity>;

export const ValidationIssue = z.object({
  code: z.string(),
  severity: ValidationSeverity,
  message: z.string(),
  /** Items involved, so the UI can highlight the exact spot in the timeline. */
  itemIds: z.array(z.string()).default([]),
  /** Concrete, actionable fixes. Never applied without the traveller's say-so. */
  suggestions: z.array(z.string()).default([]),
});
export type ValidationIssue = z.infer<typeof ValidationIssue>;

export const SelectedHotel = z.object({
  hotel: HotelOffer,
  room: HotelRoomOffer,
  rooms: z.number().int().min(1),
  checkIn: IsoDate,
  checkOut: IsoDate,
  nights: z.number().int().min(1),
  /** Straight-line distance to the centroid of the planned activities. */
  distanceToActivitiesKm: z.number().nullable().default(null),
  /** Modelled daily local transport cost implied by this hotel's location. */
  impliedDailyTransportCost: Money.nullable().default(null),
});
export type SelectedHotel = z.infer<typeof SelectedHotel>;

export const PlanArchetype = z.enum(['budget', 'balanced', 'comfort', 'custom']);
export type PlanArchetype = z.infer<typeof PlanArchetype>;

export const TripPlan = z.object({
  id: z.string(),
  archetype: PlanArchetype,
  label: z.string(),
  /** One-paragraph rationale naming the trade-offs, written by the AI layer
   *  but constrained to facts present in the plan. */
  rationale: z.string(),
  outboundTransport: TransportOffer.nullable().default(null),
  returnTransport: TransportOffer.nullable().default(null),
  hotels: z.array(SelectedHotel).default([]),
  transfers: z.array(TransferOffer).default([]),
  activities: z.array(ActivityOffer).default([]),
  days: z.array(ItineraryDay).default([]),
  cost: CostBreakdown,
  issues: z.array(ValidationIssue).default([]),
  /** Score in [0,1] against the traveller's ranked priorities. */
  priorityScore: z.number().min(0).max(1),
  /** Per-priority scores, so the UI can explain why a plan ranks where it does. */
  scoreBreakdown: z.record(z.string(), z.number()).default({}),
  tradeoffs: z.array(z.string()).default([]),
  /** Provider failures that shaped this plan, surfaced rather than hidden. */
  providerNotes: z
    .array(z.object({ provider: z.string(), status: z.string(), message: z.string() }))
    .default([]),
  generatedAt: z.string().datetime(),
});
export type TripPlan = z.infer<typeof TripPlan>;

export function hasBlockers(plan: TripPlan): boolean {
  return plan.issues.some((i) => i.severity === 'blocker');
}
