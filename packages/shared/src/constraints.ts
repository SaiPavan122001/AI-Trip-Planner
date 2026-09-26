import { z } from 'zod';
import { Money } from './money.js';
import { IsoDate, LocalTime } from './trip.js';
import { AccessibilityNeed, CabinClass, Priority } from './traveler.js';

/**
 * The constraint model is the contract between the AI layer and the
 * deterministic planner. The AI may propose constraints; only validated
 * constraints in this shape reach the engine, and the engine may never
 * violate a hard constraint without an explicit, recorded user waiver.
 */

export const HardConstraintKind = z.enum([
  'max_total_budget',
  'max_transport_budget',
  'max_accommodation_budget',
  'fixed_departure_date',
  'fixed_return_date',
  'traveler_count',
  'required_rooms',
  'required_accessibility',
  'required_free_cancellation',
  'excluded_transport_mode',
  'latest_arrival_time',
  'earliest_departure_time',
  'max_stops',
  'required_checked_bags',
]);
export type HardConstraintKind = z.infer<typeof HardConstraintKind>;

export const HardConstraint = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('max_total_budget'), value: Money }),
  z.object({ kind: z.literal('max_transport_budget'), value: Money }),
  z.object({ kind: z.literal('max_accommodation_budget'), value: Money }),
  z.object({ kind: z.literal('fixed_departure_date'), value: IsoDate }),
  z.object({ kind: z.literal('fixed_return_date'), value: IsoDate }),
  z.object({
    kind: z.literal('traveler_count'),
    value: z.object({ adults: z.number().int(), children: z.number().int(), infants: z.number().int() }),
  }),
  z.object({ kind: z.literal('required_rooms'), value: z.number().int().min(1) }),
  z.object({ kind: z.literal('required_accessibility'), value: z.array(AccessibilityNeed) }),
  z.object({ kind: z.literal('required_free_cancellation'), value: z.literal(true) }),
  z.object({ kind: z.literal('excluded_transport_mode'), value: z.string() }),
  // Local wall-clock times, HH:MM, compared in the zone where each departure
  // or arrival happens. Validated here too, not only on the profile, because
  // these are compared as strings and anything else would compare wrongly.
  z.object({ kind: z.literal('latest_arrival_time'), value: LocalTime }),
  z.object({ kind: z.literal('earliest_departure_time'), value: LocalTime }),
  z.object({ kind: z.literal('max_stops'), value: z.number().int().min(0) }),
  z.object({ kind: z.literal('required_checked_bags'), value: z.number().int().min(0) }),
]);
export type HardConstraint = z.infer<typeof HardConstraint>;

export const SoftPreferenceKind = z.enum([
  'priority_order',
  'preferred_cabin_class',
  'preferred_carrier',
  'avoided_carrier',
  'min_hotel_category',
  'preferred_hotel_area',
  'scenic_route',
  'shorter_journey',
  'fewer_transfers',
  'breakfast_included',
  'daily_spend_target',
]);
export type SoftPreferenceKind = z.infer<typeof SoftPreferenceKind>;

/**
 * Soft preferences carry a weight in [0, 1]. Weight is derived from where the
 * preference sits in the traveller's ranking, not invented by the model.
 */
export const SoftPreference = z.object({
  kind: SoftPreferenceKind,
  value: z.union([z.string(), z.number(), z.boolean(), z.array(Priority), Money]),
  weight: z.number().min(0).max(1),
});
export type SoftPreference = z.infer<typeof SoftPreference>;

export const BudgetEnvelope = z.object({
  total: Money.nullable().default(null),
  transport: Money.nullable().default(null),
  accommodation: Money.nullable().default(null),
  /** Per person, per day, for meals and incidentals. */
  dailySpend: Money.nullable().default(null),
  activities: Money.nullable().default(null),
  /**
   * False (the default) means the budget is a guide: plans above it are still
   * shown, flagged and ranked lower. True means the traveller said "do not
   * exceed" it, and it filters and blocks like any other hard constraint.
   */
  firm: z.boolean().default(false),
});
export type BudgetEnvelope = z.infer<typeof BudgetEnvelope>;

export const ConstraintSet = z.object({
  hard: z.array(HardConstraint).default([]),
  soft: z.array(SoftPreference).default([]),
  budget: BudgetEnvelope.default({}),
  /** Hard constraints the traveller has explicitly agreed to relax, with the ask recorded. */
  waivers: z
    .array(
      z.object({
        kind: HardConstraintKind,
        waivedAt: z.string().datetime(),
        reason: z.string(),
      }),
    )
    .default([]),
});
export type ConstraintSet = z.infer<typeof ConstraintSet>;

export const emptyConstraintSet = (): ConstraintSet => ConstraintSet.parse({});

export function hasWaiver(set: ConstraintSet, kind: HardConstraintKind): boolean {
  return set.waivers.some((w) => w.kind === kind);
}

export function findHard<K extends HardConstraintKind>(
  set: ConstraintSet,
  kind: K,
): Extract<HardConstraint, { kind: K }> | undefined {
  return set.hard.find((c) => c.kind === kind) as Extract<HardConstraint, { kind: K }> | undefined;
}

/**
 * Ranked priorities become weights on a decaying curve: the first priority
 * dominates, later ones still matter. The curve is deliberately gentle so that
 * a third-ranked priority is not rounded to irrelevance.
 */
export function priorityWeights(priorities: Priority[]): Map<Priority, number> {
  const weights = new Map<Priority, number>();
  const n = priorities.length;
  if (n === 0) return weights;
  priorities.forEach((p, i) => {
    weights.set(p, Number((1 / (1 + i * 0.6)).toFixed(4)));
  });
  return weights;
}

export function cabinClassRank(c: CabinClass): number {
  return { economy: 0, premium_economy: 1, business: 2, first: 3 }[c];
}
