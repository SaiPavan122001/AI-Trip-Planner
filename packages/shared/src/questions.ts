import { z } from 'zod';

/**
 * The adaptive questionnaire. Questions are data, not hard-coded UI: the engine
 * decides which question comes next from what has already been answered and
 * from the journey classification, and the frontend renders whatever it is
 * handed. This keeps "ask only what matters, one step at a time" a property of
 * the engine rather than a convention the UI has to remember.
 */

export const QuestionKind = z.enum([
  'single_choice',
  'multi_choice',
  'ranking',
  'money',
  'number',
  'boolean',
  'text',
  'time',
]);
export type QuestionKind = z.infer<typeof QuestionKind>;

export const QuestionOption = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().nullable().default(null),
  /** Shown as a consequence hint, e.g. "usually adds 2-3h to the journey". */
  implication: z.string().nullable().default(null),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

export const Question = z.object({
  /** Stable key; also the path into TravelerProfile the answer writes to. */
  key: z.string(),
  kind: QuestionKind,
  prompt: z.string(),
  helpText: z.string().nullable().default(null),
  options: z.array(QuestionOption).default([]),
  /** Only meaningful for money/number. */
  min: z.number().nullable().default(null),
  max: z.number().nullable().default(null),
  currency: z.string().nullable().default(null),
  required: z.boolean().default(false),
  /** Why this is being asked, shown on request. Builds trust in the funnel. */
  reason: z.string(),
  /** Which stage of the funnel this belongs to, for the progress indicator. */
  stage: z.enum(['budget', 'style', 'priorities', 'accommodation', 'traveler_needs', 'transport']),
});
export type Question = z.infer<typeof Question>;

export const Answer = z.object({
  key: z.string(),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
    z.object({ amount: z.number().int(), currency: z.string() }),
    z.null(),
  ]),
  /** True when the traveller chose to skip rather than answer. */
  skipped: z.boolean().default(false),
});
export type Answer = z.infer<typeof Answer>;

export const QuestionnaireState = z.object({
  /** The next question to ask, or null when enough is known to plan. */
  next: Question.nullable(),
  /** Questions already resolved, in order, for the review screen. */
  asked: z.array(z.string()).default([]),
  /** 0-1, how much of the materially useful profile is filled in. */
  completeness: z.number().min(0).max(1),
  /** True once the engine has enough to produce a plan, even if more could be asked. */
  canPlan: z.boolean(),
});
export type QuestionnaireState = z.infer<typeof QuestionnaireState>;
