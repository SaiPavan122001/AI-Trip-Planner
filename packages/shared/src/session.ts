import { z } from 'zod';
import { ConstraintSet } from './constraints.js';
import { Money } from './money.js';
import { IsoDate, JourneyClassification, LocalTime, TransportMode, TripIntent } from './trip.js';
import { Priority, TravelerProfile } from './traveler.js';
import { TripPlan } from './itinerary.js';
import { QuestionnaireState } from './questions.js';

/**
 * The planning session is the single aggregate the API reads and writes. It is
 * deliberately serialisable end-to-end so a session can be persisted, resumed,
 * replayed for debugging, and diffed when the traveller modifies the plan.
 */

export const PlanningStage = z.enum([
  'intent',
  'classified',
  'profiling',
  'searching',
  'planned',
  'modifying',
  'booking',
]);
export type PlanningStage = z.infer<typeof PlanningStage>;

export const ProviderNote = z.object({
  provider: z.string(),
  providerLabel: z.string(),
  status: z.string(),
  message: z.string(),
  occurredAt: z.string().datetime(),
});
export type ProviderNote = z.infer<typeof ProviderNote>;

// ------------------------------------------------------------ modification

/**
 * A conversational modification request. The engine resolves the intent to a
 * set of components to re-search; anything the traveller pinned is carried
 * over exactly, so they do not silently lose a hotel they liked.
 */
export const ModificationIntent = z.enum([
  'reduce_cost',
  'increase_comfort',
  'change_transport_mode',
  'change_hotel_tier',
  'avoid_overnight',
  'shift_departure_time',
  'change_party_size',
  'change_dates',
  'change_budget',
  'reprioritise',
  'replace_component',
  'add_activity',
  'remove_activity',
  'unknown',
]);
export type ModificationIntent = z.infer<typeof ModificationIntent>;

export const TripComponent = z.enum(['outbound', 'return', 'hotel', 'transfers', 'activities']);
export type TripComponent = z.infer<typeof TripComponent>;

/**
 * The parameters a modification may carry, each with the same domain rules a
 * person typing into the form would face. They usually come from a language
 * model, so they are untrusted: every field is checked on its own (see
 * `sanitizeModificationParameters`) and an invalid one is dropped, never
 * stored. Whether a value makes sense for this particular trip (a date in the
 * past, more rooms than people) is checked later by the engine.
 */
export const ModificationParameters = z
  .object({
    mode: TransportMode.optional(),
    category: z.number().int().min(0).max(5).optional(),
    earliestDeparture: LocalTime.optional(),
    latestArrival: LocalTime.optional(),
    priorities: z
      .array(Priority)
      .min(1)
      .max(4)
      .refine((p) => new Set(p).size === p.length, 'each priority once')
      .optional(),
    component: TripComponent.optional(),
    activityName: z.string().trim().min(1).max(120).optional(),
    departureDate: IsoDate.optional(),
    returnDate: IsoDate.optional(),
    adults: z.number().int().min(1).max(20).optional(),
    children: z.number().int().min(0).max(20).optional(),
    infants: z.number().int().min(0).max(10).optional(),
    /** A new total budget. Must be positive and in the trip's currency. */
    budgetTotal: Money.refine((m) => Number.isSafeInteger(m.amount) && m.amount > 0, 'positive amount').optional(),
    /** True for "do not exceed"; false for "just a guide". */
    budgetFirm: z.boolean().optional(),
  })
  .strict();
export type ModificationParameters = z.infer<typeof ModificationParameters>;

/**
 * Checks each proposed parameter independently. A valid one is kept; an
 * invalid or unknown one is dropped and named in `rejected`, so a single bad
 * value cannot take the whole request with it, and cannot reach the trip.
 */
export function sanitizeModificationParameters(raw: Record<string, unknown>): {
  parameters: ModificationParameters;
  rejected: string[];
} {
  const shape = ModificationParameters.shape;
  const parameters: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    const field = shape[key as keyof typeof shape];
    const parsed = field ? field.safeParse(value) : null;
    if (parsed?.success && parsed.data !== undefined) parameters[key] = parsed.data;
    else rejected.push(key);
  }
  return { parameters: parameters as ModificationParameters, rejected };
}

export const ModificationRequest = z.object({
  /** What the traveller typed, kept verbatim for the audit trail. */
  utterance: z.string(),
  intent: ModificationIntent,
  /** Validated parameters; see `ModificationParameters`. */
  parameters: ModificationParameters.default({}),
  /** Components that must be re-searched as a result. */
  affectedComponents: z
    .array(z.enum(['outbound', 'return', 'hotel', 'transfers', 'activities', 'all']))
    .default([]),
  /** Components explicitly pinned by the traveller ("keep the same hotel"). */
  pinnedComponents: z.array(TripComponent).default([]),
  /** Set when the change would breach a hard constraint and needs consent. */
  requiresWaiver: z.array(z.string()).default([]),
});
export type ModificationRequest = z.infer<typeof ModificationRequest>;

/**
 * Everything a modification would change, worked out in full before anything
 * is committed: the new trip facts, preferences and constraints, which parts
 * of the plan are searched again, which are kept exactly as they were, and
 * which pinned parts can no longer be kept, with the reason.
 */
export const ProposedChange = z.object({
  intent: TripIntent,
  profile: TravelerProfile,
  constraints: ConstraintSet,
  reSearch: z.array(TripComponent),
  keep: z.array(TripComponent),
  released: z.array(z.object({ component: TripComponent, reason: z.string() })),
  /** Plain-language description of the change, shown to the traveller. */
  summary: z.string(),
});
export type ProposedChange = z.infer<typeof ProposedChange>;

/**
 * A change waiting for the traveller's answer. Both outcomes are worked out
 * up front, so answering applies exactly what the question described;
 * `decline` is null when declining means nothing changes.
 */
export const PendingModification = z.object({
  id: z.string().uuid(),
  utterance: z.string(),
  intent: ModificationIntent,
  question: z.string(),
  acceptLabel: z.string(),
  declineLabel: z.string(),
  accept: ProposedChange,
  decline: ProposedChange.nullable(),
  createdAt: z.string().datetime(),
});
export type PendingModification = z.infer<typeof PendingModification>;

// ----------------------------------------------------------------- session

export const PlanningSession = z.object({
  id: z.string(),
  ownerId: z.string().nullable().default(null),
  stage: PlanningStage,
  intent: TripIntent,
  classification: JourneyClassification,
  profile: TravelerProfile,
  constraints: ConstraintSet,
  questionnaire: QuestionnaireState.nullable().default(null),
  plans: z.array(TripPlan).default([]),
  selectedPlanId: z.string().nullable().default(null),
  /** A modification that is waiting for the traveller's consent. */
  pendingModification: PendingModification.nullable().default(null),
  /** Everything a provider refused or could not answer, kept for the UI. */
  providerNotes: z.array(ProviderNote).default([]),
  /** Plain-language log of what the planner decided and why. */
  decisionLog: z
    .array(z.object({ at: z.string().datetime(), step: z.string(), detail: z.string() }))
    .default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PlanningSession = z.infer<typeof PlanningSession>;
