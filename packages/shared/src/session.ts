import { z } from 'zod';
import { ConstraintSet } from './constraints.js';
import { JourneyClassification, TripIntent } from './trip.js';
import { TravelerProfile } from './traveler.js';
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

/**
 * A conversational modification request. The engine resolves the intent to a
 * set of components to re-search; everything untouched is carried over so the
 * traveller does not silently lose a hotel they liked.
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
  'reprioritise',
  'replace_component',
  'add_activity',
  'remove_activity',
  'unknown',
]);
export type ModificationIntent = z.infer<typeof ModificationIntent>;

export const ModificationRequest = z.object({
  /** What the traveller typed, kept verbatim for the audit trail. */
  utterance: z.string(),
  intent: ModificationIntent,
  /** Structured parameters the AI extracted; validated before use. */
  parameters: z.record(z.string(), z.unknown()).default({}),
  /** Components that must be re-searched as a result. */
  affectedComponents: z
    .array(z.enum(['outbound', 'return', 'hotel', 'transfers', 'activities', 'all']))
    .default([]),
  /** Components explicitly pinned by the traveller ("keep the same hotel"). */
  pinnedComponents: z
    .array(z.enum(['outbound', 'return', 'hotel', 'transfers', 'activities']))
    .default([]),
  /** Set when the change would breach a hard constraint and needs consent. */
  requiresWaiver: z.array(z.string()).default([]),
});
export type ModificationRequest = z.infer<typeof ModificationRequest>;
