import { z } from 'zod';
import { StayAmenity, StayArea } from '@trip/shared';
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
 * The Accommodation Agent: what should the stay be like?
 *
 * It turns what the traveller said about where and how they want to sleep into
 * soft guidance the hotel search and ranking can use. It never invents
 * availability or a room price, never sets a room count (that is a hard
 * requirement the traveller answers, and is checked elsewhere), and never
 * raises a soft wish into a filter.
 *
 * Every value it proposes must be one the traveller stated or their own words
 * mention; a wish that was never expressed is dropped.
 */

export interface AccommodationGuidance {
  area: StayArea | null;
  /** Breakfast included is the one amenity the ranking scores today. */
  breakfast: boolean;
  amenities: StayAmenity[];
  reasons: string[];
}

export interface AccommodationAgentInput {
  nights: number;
  travelers: { adults: number; children: number; infants: number };
  stated: StatedContext;
}

const Raw = z.object({
  area: z.string().nullable().default(null),
  amenities: z.array(z.string()).default([]),
  reasons: z.array(z.string()).default([]),
});
type Raw = z.infer<typeof Raw>;

const SYSTEM = `You help decide what a traveller's stay should be like. You are given how many nights and how many people, and what the traveller said they like.

You never invent or estimate availability or a room price, and you never choose a number of rooms. You only turn what the traveller said into: area, one of near_activities, central, quiet, near_transport, or null; amenities, from wifi, breakfast, pool, parking, air_conditioning, gym, spa, kitchen, family_rooms. Include an area or amenity only if the traveller's own words ask for it. If they said nothing about it, leave it out.

- reasons: up to three short sentences with no numbers, prices or times.

${DATA_NOTICE}`;

const empty = (): AccommodationGuidance => ({ area: null, breakfast: false, amenities: [], reasons: [] });

function build(
  input: AccommodationAgentInput,
  area: string | null,
  amenities: readonly string[],
  reasons: readonly string[],
): Produced<AccommodationGuidance> {
  const rejected: string[] = [];
  let chosenArea: StayArea | null = null;
  if (area !== null) {
    const parsed = StayArea.safeParse(area);
    if (!parsed.success) rejected.push('area: not one of the allowed areas');
    else if (!grounded('stay_area', parsed.data, input.stated)) rejected.push('area: the traveller did not ask for it');
    else chosenArea = parsed.data;
  }
  const chosen: StayAmenity[] = [];
  for (const raw of amenities.slice(0, 12)) {
    const parsed = StayAmenity.safeParse(raw);
    if (!parsed.success) { rejected.push('amenity: not one of the allowed amenities'); continue; }
    if (!grounded('amenity', parsed.data, input.stated)) { rejected.push(`amenity ${parsed.data}: the traveller did not ask for it`); continue; }
    if (!chosen.includes(parsed.data)) chosen.push(parsed.data);
  }
  return {
    ok: true,
    data: { area: chosenArea, breakfast: chosen.includes('breakfast'), amenities: chosen, reasons: cleanReasons(reasons, rejected) },
    rejected,
  };
}

const spec: AgentSpec<Raw, AccommodationAgentInput, AccommodationGuidance> = {
  name: 'accommodation',
  system: SYSTEM,
  schemaName: 'accommodation_guidance',
  schemaDescription: 'The stay preferences the traveller expressed, in a closed vocabulary.',
  schema: Raw,
  buildInput: (input) =>
    [
      `Nights: ${input.nights}. Travellers: ${input.travelers.adults} adult(s), ${input.travelers.children} child(ren), ${input.travelers.infants} infant(s).`,
      asData('what_the_traveller_said', input.stated.text),
    ].join('\n'),
  sanitise: (raw, input) => build(input, raw.area, raw.amenities, raw.reasons),
  fallback: (input) =>
    build(
      input,
      input.stated.soft.find((s) => s.kind === 'stay_area')?.value ?? null,
      input.stated.soft.filter((s) => s.kind === 'amenity').map((s) => s.value),
      [],
    ),
};

export function runAccommodationAgent(
  input: AccommodationAgentInput,
  ctx: AgentContext,
): Promise<AgentOutcome<AccommodationGuidance>> {
  // No nights, no stay: nothing to advise on, and no model call to spend.
  if (input.nights <= 0) {
    return Promise.resolve({
      ok: true,
      data: empty(),
      meta: { agent: 'accommodation', source: 'rules', model: null, durationMs: 0, warnings: ['There is no overnight stay on this trip.'], rejected: [] },
    });
  }
  // Nothing said, nothing to interpret.
  if (input.stated.soft.length === 0 && input.stated.text.length === 0) {
    return Promise.resolve({
      ok: true,
      data: empty(),
      meta: { agent: 'accommodation', source: 'rules', model: null, durationMs: 0, warnings: [], rejected: [] },
    });
  }
  return runAgent(spec, input, ctx);
}
