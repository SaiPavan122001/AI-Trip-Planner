import { z } from 'zod';
import { Money } from './money.js';

/**
 * What a traveller said they want, as the Requirements Agent understood it and
 * the deterministic checks accepted it.
 *
 * Every item carries `evidence`: the words of the traveller's own message it
 * came from. That is what stops the state being a place where a model's
 * guesses become facts: an item with no quote that really appears in the
 * message is dropped before it gets here.
 *
 * `hard` and `soft` are kept apart on purpose. A hard requirement removes
 * options; a soft preference only orders them. The agent decides which words
 * are which; the vocabulary of each is closed and checked in code.
 */

export const HardKind = z.enum([
  'excluded_mode',
  'required_mode',
  'avoid_overnight',
  'max_stops',
  'min_hotel_category',
  'accessibility',
  'rooms',
  'latest_arrival',
  'earliest_departure',
  'free_cancellation',
  'dietary',
]);
export type HardKind = z.infer<typeof HardKind>;

export const SoftKind = z.enum([
  'priority',
  'preferred_mode',
  'travel_style',
  'amenity',
  'stay_area',
  'activity_interest',
  'pace',
  'cabin_class',
  'party_type',
]);
export type SoftKind = z.infer<typeof SoftKind>;

const Evidence = z.string().min(1).max(200);

export const StatedHard = z.object({
  kind: HardKind,
  value: z.string().min(1).max(40),
  evidence: Evidence,
});
export type StatedHard = z.infer<typeof StatedHard>;

export const StatedSoft = z.object({
  kind: SoftKind,
  value: z.string().min(1).max(40),
  evidence: Evidence,
});
export type StatedSoft = z.infer<typeof StatedSoft>;

/** What the planner cannot go on without, named so a client can ask for it. */
export const MissingField = z.enum(['origin', 'destination', 'departure_date', 'travelers']);
export type MissingField = z.infer<typeof MissingField>;

export const RequirementsState = z.object({
  trip: z.object({
    origin: z.string().nullable().default(null),
    destination: z.string().nullable().default(null),
    departureDate: z.string().nullable().default(null),
    returnDate: z.string().nullable().default(null),
    travelers: z
      .object({
        adults: z.number().int().min(1).max(20),
        children: z.number().int().min(0).max(20),
        infants: z.number().int().min(0).max(10),
      })
      .nullable()
      .default(null),
  }),
  budget: z.object({
    total: Money.nullable().default(null),
    /** True for "do not exceed", false for "just a guide", null when not said. */
    firm: z.boolean().nullable().default(null),
  }),
  hard: z.array(StatedHard).default([]),
  soft: z.array(StatedSoft).default([]),
  /** What is still needed, each with the question to ask. Recomputed in code, never taken from a model. */
  missing: z
    .array(z.object({ field: MissingField, question: z.string() }))
    .default([]),
  /** Requirements that contradict each other or the calendar, found in code. */
  conflicts: z.array(z.object({ fields: z.array(z.string()), message: z.string() })).default([]),
  /** Nothing missing and nothing in conflict. */
  complete: z.boolean().default(false),
});
export type RequirementsState = z.infer<typeof RequirementsState>;

export const emptyRequirements = (): RequirementsState =>
  RequirementsState.parse({ trip: {}, budget: {} });
