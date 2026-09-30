import { z } from 'zod';
import { ActivityInterest, ActivityPace } from '@trip/shared';
import {
  DATA_NOTICE,
  asData,
  runAgent,
  type AgentContext,
  type AgentOutcome,
  type AgentSpec,
  type Produced,
} from '../contract.js';
import { cleanReasons, grounded, type StatedContext } from './common.js';

/**
 * The Activity / Destination Agent: what does the traveller want to do there?
 *
 * It turns what the traveller said about how they like to spend their days
 * into a closed set of interests and a pace. Deterministic code translates
 * those into the place types a provider is asked for and the number of things
 * planned each day; opening hours, availability and prices come only from the
 * provider, and the agent names no place at all. It cannot create an activity.
 *
 * Interests and pace must be ones the traveller stated or their words mention.
 */

export interface ActivityAgentGuidance {
  interests: ActivityInterest[];
  pace: ActivityPace | null;
  reasons: string[];
}

export interface ActivityAgentInput {
  /** Days with time to fill; zero means a trip with nothing to plan. */
  days: number;
  stated: StatedContext;
}

const Raw = z.object({
  interests: z.array(z.string()).default([]),
  pace: z.string().nullable().default(null),
  reasons: z.array(z.string()).default([]),
});
type Raw = z.infer<typeof Raw>;

const SYSTEM = `You help decide what a traveller wants to do at their destination. You are given how many days there are to fill and what the traveller said they like.

You never name a specific place, and you never state opening hours, prices or availability: those come from a provider. You only turn what the traveller said into: interests, from museums, history, nature, beaches, adventure, religious, shopping, nightlife, family; and pace, one of relaxed, balanced, packed, or null. Include an interest or pace only if the traveller's own words express it. If they said nothing about it, leave it out.

- reasons: up to three short sentences with no numbers, prices or times.

${DATA_NOTICE}`;

const MAX_INTERESTS = 4;

function build(
  input: ActivityAgentInput,
  interests: readonly string[],
  pace: string | null,
  reasons: readonly string[],
): Produced<ActivityAgentGuidance> {
  const rejected: string[] = [];
  const chosen: ActivityInterest[] = [];
  for (const raw of interests.slice(0, 12)) {
    const parsed = ActivityInterest.safeParse(raw);
    if (!parsed.success) { rejected.push('interest: not one of the allowed interests'); continue; }
    if (!grounded('activity_interest', parsed.data, input.stated)) { rejected.push(`interest ${parsed.data}: the traveller did not express it`); continue; }
    if (!chosen.includes(parsed.data)) chosen.push(parsed.data);
  }
  if (chosen.length > MAX_INTERESTS) rejected.push(`Only the first ${MAX_INTERESTS} interests are used.`);

  let chosenPace: ActivityPace | null = null;
  if (pace !== null) {
    const parsed = ActivityPace.safeParse(pace);
    if (!parsed.success) rejected.push('pace: not one of the allowed paces');
    else if (!grounded('pace', parsed.data, input.stated)) rejected.push('pace: the traveller did not express it');
    else chosenPace = parsed.data;
  }
  return {
    ok: true,
    data: { interests: chosen.slice(0, MAX_INTERESTS), pace: chosenPace, reasons: cleanReasons(reasons, rejected) },
    rejected,
  };
}

const spec: AgentSpec<Raw, ActivityAgentInput, ActivityAgentGuidance> = {
  name: 'activity',
  system: SYSTEM,
  schemaName: 'activity_guidance',
  schemaDescription: 'The interests and pace the traveller expressed, in a closed vocabulary.',
  schema: Raw,
  buildInput: (input) =>
    [`Days to fill: ${input.days}.`, asData('what_the_traveller_said', input.stated.text)].join('\n'),
  sanitise: (raw, input) => build(input, raw.interests, raw.pace, raw.reasons),
  fallback: (input) =>
    build(
      input,
      input.stated.soft.filter((s) => s.kind === 'activity_interest').map((s) => s.value),
      input.stated.soft.find((s) => s.kind === 'pace')?.value ?? null,
      [],
    ),
};

const none = (warnings: string[] = []): AgentOutcome<ActivityAgentGuidance> => ({
  ok: true,
  data: { interests: [], pace: null, reasons: [] },
  meta: { agent: 'activity', source: 'rules', model: null, durationMs: 0, warnings, rejected: [] },
});

export function runActivityAgent(
  input: ActivityAgentInput,
  ctx: AgentContext,
): Promise<AgentOutcome<ActivityAgentGuidance>> {
  if (input.days <= 0) return Promise.resolve(none(['There are no free days on this trip.']));
  if (input.stated.text.length === 0) return Promise.resolve(none());
  return runAgent(spec, input, ctx);
}
