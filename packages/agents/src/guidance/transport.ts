import { z } from 'zod';
import { TransportMode } from '@trip/shared';
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
 * The Transport Agent: how should this journey be travelled?
 *
 * It works out which ways of travelling are worth consulting, and, from what
 * the traveller said, which one to favour. It does not search, price, or time
 * anything: fares, schedules and durations come from providers and the engine,
 * and a self-drive is still a ₹0 fare with its distance and duration measured
 * elsewhere.
 *
 * What it may and may not do:
 *  - The set of modes to consult is decided in code: the modes the journey
 *    allows, minus any the traveller ruled out. The model cannot add a mode the
 *    classifier ruled out, and cannot remove one the traveller did not.
 *  - A required mode ("only by train") that this journey cannot use is an
 *    `impossible` error, said plainly, not quietly widened.
 *  - A favoured mode must be one the traveller stated or their words mention.
 */

export interface TransportGuidance {
  /** Modes to search: allowed by the journey, not ruled out. Decided in code. */
  consult: TransportMode[];
  /** The way of travelling to favour, or null. Never overrides an explicit choice. */
  preferredMode: TransportMode | null;
  /** `consult`, in the order the traveller's words suggest. */
  modeOrder: TransportMode[];
  /** Why, for the trace. Never shown to a traveller as fact. */
  reasons: string[];
}

export interface TransportAgentInput {
  scope: 'domestic' | 'international';
  eligibleModes: TransportMode[];
  /** Modes the traveller ruled out (the profile's, plus any just stated). */
  excludedModes: TransportMode[];
  /** Set when the traveller said this is the only way they will travel. */
  requiredMode: TransportMode | null;
  /** A preference already on the trip; the agent never overrides it. */
  currentPreferredMode: TransportMode | null;
  stated: StatedContext;
}

const Raw = z.object({
  preferredMode: z.string().nullable().default(null),
  modeOrder: z.array(z.string()).default([]),
  reasons: z.array(z.string()).default([]),
});
type Raw = z.infer<typeof Raw>;

const SYSTEM = `You help decide how a journey should be travelled. You are given the ways of travelling this journey allows, the ones the traveller ruled out, and what they said they like.

You never invent or estimate a price, a schedule, a journey time or availability. You only choose which allowed mode to favour, and in what order the allowed modes are worth looking at, based on what the traveller said. If they did not say anything that favours a mode, return null for preferredMode.

- preferredMode: one of the allowed modes, only if the traveller's own words favour it.
- modeOrder: the allowed modes, most relevant first.
- reasons: up to three short sentences with no numbers, prices or times.

${DATA_NOTICE}`;

/** The modes to consult, or why there are none. Deterministic. */
export function consultableModes(
  input: Pick<TransportAgentInput, 'eligibleModes' | 'excludedModes' | 'requiredMode'>,
): { ok: true; modes: TransportMode[] } | { ok: false; message: string } {
  const excluded = new Set(input.excludedModes);
  const allowed = input.eligibleModes.filter((m) => !excluded.has(m));
  if (input.requiredMode) {
    if (!input.eligibleModes.includes(input.requiredMode)) {
      return {
        ok: false,
        message: `You asked to travel only by ${input.requiredMode.replace('_', ' ')}, which is not possible for this journey.`,
      };
    }
    if (excluded.has(input.requiredMode)) {
      return { ok: false, message: 'You asked to travel only by a way you also ruled out.' };
    }
    return { ok: true, modes: [input.requiredMode] };
  }
  if (allowed.length === 0) {
    return { ok: false, message: 'Every way of travelling this journey allows has been ruled out.' };
  }
  return { ok: true, modes: allowed };
}

const parseMode = (value: string | null): TransportMode | null => {
  const parsed = TransportMode.safeParse(value);
  return parsed.success ? parsed.data : null;
};

function build(
  input: TransportAgentInput,
  modes: TransportMode[],
  preferred: string | null,
  order: readonly string[],
  reasons: readonly string[],
  rejected: string[],
): TransportGuidance {
  let preferredMode = parseMode(preferred);
  if (preferredMode && !modes.includes(preferredMode)) {
    rejected.push('preferred mode: not among the modes this journey allows');
    preferredMode = null;
  }
  if (preferredMode && !grounded('preferred_mode', preferredMode, input.stated)) {
    rejected.push('preferred mode: the traveller did not say anything that favours it');
    preferredMode = null;
  }
  // An explicit choice already on the trip stands.
  if (input.currentPreferredMode) preferredMode = null;

  const ordered: TransportMode[] = [];
  for (const raw of order) {
    const mode = parseMode(raw);
    if (mode && modes.includes(mode) && !ordered.includes(mode)) ordered.push(mode);
  }
  for (const mode of modes) if (!ordered.includes(mode)) ordered.push(mode);
  if (preferredMode) ordered.splice(0, ordered.length, preferredMode, ...ordered.filter((m) => m !== preferredMode));

  return { consult: modes, preferredMode, modeOrder: ordered, reasons: cleanReasons(reasons, rejected) };
}

function sanitise(raw: Raw, input: TransportAgentInput): Produced<TransportGuidance> {
  const modes = consultableModes(input);
  if (!modes.ok) return { ok: false, error: { code: 'impossible', message: modes.message } };
  const rejected: string[] = [];
  return { ok: true, data: build(input, modes.modes, raw.preferredMode, raw.modeOrder, raw.reasons, rejected), rejected };
}

function fallback(input: TransportAgentInput): Produced<TransportGuidance> {
  const modes = consultableModes(input);
  if (!modes.ok) return { ok: false, error: { code: 'impossible', message: modes.message } };
  const rejected: string[] = [];
  const stated = input.stated.soft.find((s) => s.kind === 'preferred_mode')?.value ?? null;
  return { ok: true, data: build(input, modes.modes, stated, [], [], rejected), rejected };
}

const spec: AgentSpec<Raw, TransportAgentInput, TransportGuidance> = {
  name: 'transport',
  system: SYSTEM,
  schemaName: 'transport_guidance',
  schemaDescription: 'Which allowed mode of travel to favour, and the order to consider them in.',
  schema: Raw,
  buildInput: (input) =>
    [
      `Journey: ${input.scope}.`,
      `Allowed modes: ${input.eligibleModes.join(', ')}.`,
      `Ruled out by the traveller: ${input.excludedModes.join(', ') || 'none'}.`,
      asData('what_the_traveller_said', input.stated.text),
    ].join('\n'),
  sanitise,
  fallback,
};

export function runTransportAgent(
  input: TransportAgentInput,
  ctx: AgentContext,
): Promise<AgentOutcome<TransportGuidance>> {
  // The conclusion that nothing can be done needs no model, and must not
  // depend on one being available.
  const modes = consultableModes(input);
  if (!modes.ok) {
    return Promise.resolve({
      ok: false,
      error: { code: 'impossible', message: modes.message },
      meta: { agent: 'transport', source: 'rules', model: null, durationMs: 0, warnings: [], rejected: [] },
    });
  }
  return runAgent(spec, input, ctx);
}
