import type { Answer, RequirementsState, TransportMode } from '@trip/shared';

/**
 * Turning what the traveller said into the answers the interview would have
 * collected.
 *
 * This is the only route by which agent output reaches a trip's preferences,
 * and it goes through the same door as a click: each answer produced here is
 * applied one at a time by the trip service's ordinary `answer` path, which
 * checks it against the question as it was asked for this trip, refuses what
 * does not apply, and never lets a requirement bypass the rules an answer has
 * to meet. The requirements agent gets no way in that a form would not have.
 *
 * What cannot be expressed as an answer is not dropped quietly: it is either
 * kept for the planning agents (interests, pace, preferred mode…) or reported
 * as `unmapped` with the reason.
 */

export interface AnswerContext {
  /** Modes this journey allows; the mode question only offers these. */
  eligibleModes: TransportMode[];
}

export interface MappedAnswers {
  answers: Answer[];
  /** Said, but there is no answer that carries it yet: the traveller is told. */
  unmapped: Array<{ item: string; reason: string }>;
  /** Said, and used by the planning agents rather than as an answer. */
  keptForPlanning: string[];
}

const label = (kind: string, value: string) => `${kind.replace(/_/g, ' ')}: ${value.replace(/_/g, ' ')}`;

export function requirementsToAnswers(state: RequirementsState, ctx: AnswerContext): MappedAnswers {
  const answers: Answer[] = [];
  const unmapped: MappedAnswers['unmapped'] = [];
  const keptForPlanning: string[] = [];
  const answer = (key: string, value: Answer['value']) => answers.push({ key, value, skipped: false });

  if (state.budget.total) {
    answer('budget.total', state.budget.total);
    if (state.budget.firm !== null) answer('budget.firm', state.budget.firm ? 'firm' : 'guide');
  }

  const style = state.soft.find((s) => s.kind === 'travel_style');
  if (style) answer('style.travel_style', style.value);

  const priorities = [...new Set(state.soft.filter((s) => s.kind === 'priority').map((s) => s.value))].slice(0, 4);
  if (priorities.length > 0) answer('priorities.ranking', priorities);

  const cabin = state.soft.find((s) => s.kind === 'cabin_class');
  if (cabin) answer('transport.cabin_class', cabin.value);
  const party = state.soft.find((s) => s.kind === 'party_type');
  if (party) answer('traveler.party_type', party.value);

  const accessibility = state.hard.filter((h) => h.kind === 'accessibility').map((h) => h.value);
  if (accessibility.length > 0) answer('traveler.accessibility', [...new Set(accessibility)]);
  const dietary = state.hard.filter((h) => h.kind === 'dietary').map((h) => h.value);
  if (dietary.length > 0) answer('traveler.dietary', [...new Set(dietary)]);

  const rooms = state.hard.find((h) => h.kind === 'rooms');
  if (rooms) answer('accommodation.rooms', Number(rooms.value));

  const category = state.hard.find((h) => h.kind === 'min_hotel_category');
  if (category) {
    if (['3', '4', '5'].includes(category.value)) answer('accommodation.category', category.value);
    else unmapped.push({ item: label(category.kind, category.value), reason: 'Only a minimum of 3, 4 or 5 stars can be asked for.' });
  }

  if (state.hard.some((h) => h.kind === 'avoid_overnight')) answer('transport.overnight', false);

  // Modes: "only by train" and "no buses" both become the list of modes to consider.
  const required = state.hard.find((h) => h.kind === 'required_mode')?.value;
  const excluded = new Set(state.hard.filter((h) => h.kind === 'excluded_mode').map((h) => h.value));
  if (required || excluded.size > 0) {
    const allowed = required
      ? ctx.eligibleModes.filter((m) => m === required)
      : ctx.eligibleModes.filter((m) => !excluded.has(m));
    if (allowed.length === 0) {
      unmapped.push({
        item: 'transport modes',
        reason: 'Nothing this journey allows is left once that is applied, so it was not applied.',
      });
    } else {
      answer('transport.mode_openness', allowed);
    }
  }

  for (const h of state.hard) {
    if (['max_stops', 'latest_arrival', 'earliest_departure', 'free_cancellation'].includes(h.kind)) {
      unmapped.push({
        item: label(h.kind, h.value),
        reason: 'This is understood, but there is no question that carries it yet. Ask for it as a change to the plan.',
      });
    }
  }

  for (const s of state.soft) {
    if (['activity_interest', 'pace', 'amenity', 'stay_area', 'preferred_mode'].includes(s.kind)) {
      keptForPlanning.push(label(s.kind, s.value));
    }
  }

  return { answers, unmapped, keptForPlanning };
}
