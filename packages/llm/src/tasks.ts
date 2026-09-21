import { z } from 'zod';
import { ModificationIntent, type ModificationRequest } from '@trip/shared';
import { LlmUnavailableError, type LlmProvider } from './types.js';

/**
 * The three jobs the model actually has.
 *
 * Each one has a deterministic fallback that runs when no model is configured
 * or when the model is unavailable, so the product degrades in quality rather
 * than breaking. The fallbacks are keyword rules: blunter than a model, and
 * entirely predictable, which is the right trade for a feature that decides
 * what to re-search.
 */

const ModificationSchema = z.object({
  intent: ModificationIntent,
  parameters: z
    .object({
      mode: z.string().nullable().default(null),
      category: z.number().nullable().default(null),
      earliestDeparture: z.string().nullable().default(null),
      latestArrival: z.string().nullable().default(null),
      priorities: z.array(z.string()).default([]),
      component: z.string().nullable().default(null),
      activityName: z.string().nullable().default(null),
    })
    .default({}),
  pinnedComponents: z
    .array(z.enum(['outbound', 'return', 'hotel', 'transfers', 'activities']))
    .default([]),
  /** One line explaining the reading, shown back to the traveller to confirm. */
  interpretation: z.string(),
});

const MODIFICATION_SYSTEM = `You classify a traveller's request to change an existing trip plan.

You are a router, not a planner. You never invent prices, schedules, availability or place names, and you never decide what the new plan should be. Your only output is a structured description of what the traveller asked for.

Rules:
- Choose exactly one intent. If the request is ambiguous or you are unsure, choose "unknown" rather than guessing; the system will ask the traveller instead of acting on a guess.
- Fill only the parameters the traveller actually stated. Leave everything else null or empty.
- "Keep the same X" means X goes in pinnedComponents.
- "Make it cheaper" is reduce_cost. "I want a nicer hotel" is change_hotel_tier. "Use the train" is change_transport_mode with mode: "train".
- Valid modes: flight, train, bus, self_drive, rental_car, taxi, ferry.
- Valid priorities: cheapest, fastest, most_comfortable, safest, luxury, family_friendly, flexible, scenic, least_travel_time, fewest_transfers.
- interpretation is one plain sentence describing what you understood, written for the traveller to confirm.`;

export class TripLlm {
  constructor(private readonly provider: LlmProvider | null) {}

  get available(): boolean {
    return this.provider?.isConfigured() ?? false;
  }

  get label(): string {
    return this.provider?.label ?? 'Rule-based fallback';
  }

  /**
   * Turns "make it cheaper but keep the hotel" into something the engine can
   * apply. The engine still decides what that means; this only names the ask.
   */
  async interpretModification(
    utterance: string,
    context: { hasHotel: boolean; modes: string[] },
  ): Promise<{ request: ModificationRequest; interpretation: string; fromFallback: boolean }> {
    if (this.provider?.isConfigured()) {
      try {
        const result = await this.provider.extract({
          system: MODIFICATION_SYSTEM,
          input: `Available transport modes for this trip: ${context.modes.join(', ') || 'none'}.
The plan ${context.hasHotel ? 'includes' : 'does not include'} accommodation.

Traveller said: "${utterance}"`,
          schema: ModificationSchema,
          schemaName: 'trip_modification',
          schemaDescription: 'The structured form of a request to change a trip plan.',
          maxOutputTokens: 1024,
        });

        const p = result.data.parameters;
        const parameters: Record<string, unknown> = {};
        if (p.mode) parameters['mode'] = p.mode;
        if (p.category !== null) parameters['category'] = p.category;
        if (p.earliestDeparture) parameters['earliestDeparture'] = p.earliestDeparture;
        if (p.latestArrival) parameters['latestArrival'] = p.latestArrival;
        if (p.priorities.length) parameters['priorities'] = p.priorities;
        if (p.component) parameters['component'] = p.component;
        if (p.activityName) parameters['activityName'] = p.activityName;

        return {
          request: {
            utterance,
            intent: result.data.intent,
            parameters,
            affectedComponents: [],
            pinnedComponents: result.data.pinnedComponents,
            requiresWaiver: [],
          },
          interpretation: result.data.interpretation,
          fromFallback: false,
        };
      } catch (err) {
        if (!(err instanceof LlmUnavailableError)) throw err;
        // Fall through to the rules below: a model outage must not stop a
        // traveller from editing their own trip.
      }
    }

    const fallback = interpretModificationByRules(utterance);
    return { ...fallback, fromFallback: true };
  }
}

const MODE_WORDS: Array<[RegExp, string]> = [
  [/\btrains?\b|\brail\b/i, 'train'],
  [/\bbus(es)?\b|\bcoach\b/i, 'bus'],
  [/\bfly\b|\bflights?\b|\bplane\b/i, 'flight'],
  [/\bdrive\b|\bcar\b|\broad trip\b/i, 'self_drive'],
  [/\btaxi\b|\bcab\b/i, 'taxi'],
];

/**
 * The deterministic fallback. It is deliberately conservative: anything it
 * cannot match confidently becomes `unknown`, which makes the system ask
 * rather than act. A wrong guess here would silently re-search and replace
 * parts of a plan the traveller was happy with.
 */
export function interpretModificationByRules(utterance: string): {
  request: ModificationRequest;
  interpretation: string;
} {
  const text = utterance.toLowerCase();
  const pinned: ModificationRequest['pinnedComponents'] = [];
  if (/keep (the )?(same )?hotel|same hotel|don'?t change the hotel/.test(text)) pinned.push('hotel');
  if (/keep (the )?(same )?flight|same flight/.test(text)) pinned.push('outbound');

  const build = (
    intent: ModificationRequest['intent'],
    parameters: Record<string, unknown>,
    interpretation: string,
  ) => ({
    request: {
      utterance,
      intent,
      parameters,
      affectedComponents: [],
      pinnedComponents: pinned,
      requiresWaiver: [],
    },
    interpretation,
  });

  if (/cheaper|less expensive|lower (the )?(cost|price)|reduce (the )?cost|save money/.test(text)) {
    return build('reduce_cost', {}, 'Re-planning with price as the first priority.');
  }
  if (/luxur|nicer|more comfortable|upgrade|better hotel|5[- ]star|four star|4[- ]star/.test(text)) {
    const star = /5[- ]star|five star/.test(text) ? 5 : /4[- ]star|four star/.test(text) ? 4 : null;
    return star !== null
      ? build('change_hotel_tier', { category: star }, `Looking only at ${star}-star properties.`)
      : build('increase_comfort', {}, 'Re-planning with comfort as the first priority.');
  }
  if (/no overnight|not overnight|avoid overnight|don'?t.*overnight/.test(text)) {
    return build('avoid_overnight', {}, 'Avoiding overnight travel.');
  }
  for (const [pattern, mode] of MODE_WORDS) {
    if (pattern.test(text) && /\b(use|take|instead|by|switch|rather)\b/.test(text)) {
      return build(
        'change_transport_mode',
        { mode },
        `Re-planning the journey around ${mode.replace('_', ' ')}.`,
      );
    }
  }
  if (/\b(morning|evening|afternoon|later|earlier)\b.*\b(depart|leave|flight|train)\b|\b(depart|leave)\b.*\b(morning|evening|afternoon|later|earlier)\b/.test(text)) {
    const earliest = /evening/.test(text) ? '17:00' : /afternoon/.test(text) ? '12:00' : /morning/.test(text) ? '06:00' : null;
    return build(
      'shift_departure_time',
      earliest ? { earliestDeparture: earliest } : {},
      earliest ? `Departing no earlier than ${earliest}.` : 'Adjusting the departure time.',
    );
  }
  if (/add (another|one more|a) (traveller|traveler|person|adult|child)/.test(text)) {
    return build('change_party_size', {}, 'Changing the number of travellers.');
  }
  if (/safety|safest|prioriti[sz]e safety/.test(text)) {
    return build(
      'reprioritise',
      { priorities: ['safest', 'most_comfortable', 'cheapest'] },
      'Putting safety first in the ranking.',
    );
  }

  return build(
    'unknown',
    {},
    'That request was not understood clearly enough to change the plan, so nothing has changed.',
  );
}
