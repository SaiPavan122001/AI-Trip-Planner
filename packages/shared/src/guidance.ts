import { z } from 'zod';

/**
 * The closed vocabularies the planning agents may speak in.
 *
 * An agent's output is untrusted, so it is never allowed to name a free-form
 * thing that reaches a provider or a constraint. It chooses from these lists;
 * deterministic code translates a choice into whatever a provider needs (place
 * types, room counts, search radii). A value outside a list is dropped, not
 * passed on.
 */

/** What a traveller may want to do at the destination. */
export const ActivityInterest = z.enum([
  'museums',
  'history',
  'nature',
  'beaches',
  'adventure',
  'religious',
  'shopping',
  'nightlife',
  'family',
]);
export type ActivityInterest = z.infer<typeof ActivityInterest>;

/** How full the days should be. Translated to a number of activities a day by code. */
export const ActivityPace = z.enum(['relaxed', 'balanced', 'packed']);
export type ActivityPace = z.infer<typeof ActivityPace>;

export const ACTIVITIES_PER_DAY: Record<ActivityPace, number> = {
  relaxed: 1,
  balanced: 2,
  packed: 3,
};

/** Where in the destination the traveller would like to sleep, relative to their days. */
export const StayArea = z.enum(['near_activities', 'central', 'quiet', 'near_transport']);
export type StayArea = z.infer<typeof StayArea>;

/** Amenities a traveller may ask for; matched against what a provider publishes. */
export const StayAmenity = z.enum([
  'wifi',
  'breakfast',
  'pool',
  'parking',
  'air_conditioning',
  'gym',
  'spa',
  'kitchen',
  'family_rooms',
]);
export type StayAmenity = z.infer<typeof StayAmenity>;

// ------------------------------------------------------------- the record

/**
 * What the planning agents and services did on a search, kept with the trip so
 * a plan can be explained and debugged afterwards. Nothing in a trace is a
 * traveller's own words or a secret: only stage names, outcomes, timings and
 * short fixed-vocabulary notes.
 */
export const AgentTraceEntry = z.object({
  stage: z.enum([
    'transport_agent',
    'accommodation_agent',
    'activity_agent',
    'guidance',
    'plan_search',
    'validation',
    'synthesis_agent',
  ]),
  kind: z.enum(['agent', 'service']),
  /** ok: as intended. degraded: a fallback or partial result stood in. failed: no usable result. skipped: nothing to do. */
  status: z.enum(['ok', 'degraded', 'failed', 'skipped']),
  /** For an agent: who produced the answer. */
  source: z.enum(['model', 'rules']).nullable().default(null),
  durationMs: z.number().int().min(0),
  /** One sentence, written in code. */
  detail: z.string().max(300),
  warnings: z.array(z.string().max(300)).max(10).default([]),
  /** What was proposed and dropped, and the rule that dropped it. */
  rejected: z.array(z.string().max(300)).max(20).default([]),
});
export type AgentTraceEntry = z.infer<typeof AgentTraceEntry>;

/** The explanation shown with a set of plans. Every part is checked against the facts. */
export const PlanNarrative = z.object({
  summary: z.string().max(1200),
  /** A paragraph per plan, by plan id. */
  plans: z.record(z.string(), z.string().max(1000)).default({}),
  /** template: written in code. model: written by the Synthesis Agent and fact-checked. mixed: both. */
  source: z.enum(['model', 'template', 'mixed']),
  builtAt: z.string().datetime(),
});
export type PlanNarrative = z.infer<typeof PlanNarrative>;
