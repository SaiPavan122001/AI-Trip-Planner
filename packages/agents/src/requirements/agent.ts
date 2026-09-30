import { z } from 'zod';
import type { StatedHard, RequirementsState, StatedSoft } from '@trip/shared';
import {
  DATA_NOTICE,
  asData,
  isQuoteOf,
  runAgent,
  type AgentContext,
  type AgentOutcome,
  type AgentSpec,
  type Produced,
} from '../contract.js';
import { finalise, type KnownTrip, type RequirementsDraft } from './finalise.js';
import { draftFromRules } from './rules.js';
import { findDates, numbersIn, parseRupees } from './text.js';
import { FIRM_CUE, GUIDE_CUE, HARD_VALUES, SOFT_VALUES, evidenceMentions } from './vocabulary.js';

/**
 * The Requirements Agent: what did the traveller ask for?
 *
 * It reads a message in plain language and proposes structured requirements,
 * each with a quote from the message. Everything it proposes is then checked
 * in code:
 *
 *  - the quote has to really appear in the message;
 *  - dates and amounts are re-read from the quote, so the model's arithmetic
 *    is never used (an amount is only accepted if the quote states it; a date
 *    only if the quote names it);
 *  - counts must appear in the quote;
 *  - every hard or soft item must come from a closed vocabulary, and its quote
 *    must talk about that very thing;
 *  - what is missing, and what contradicts what, is worked out afterwards in
 *    code, so the model cannot hide a gap.
 *
 * What fails a check is dropped and listed in `rejected`; nothing is repaired
 * by guessing.
 */

const Quoted = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value, evidence: z.string() }).nullable().default(null);

const Item = z.object({ kind: z.string(), value: z.string(), evidence: z.string() });

const RawRequirements = z.object({
  origin: Quoted(z.string()),
  destination: Quoted(z.string()),
  departureDate: Quoted(z.string()),
  returnDate: Quoted(z.string()),
  adults: Quoted(z.number()),
  children: Quoted(z.number()),
  infants: Quoted(z.number()),
  budgetTotalRupees: Quoted(z.number()),
  budgetFirm: Quoted(z.boolean()),
  hard: z.array(Item).default([]),
  soft: z.array(Item).default([]),
});
type RawRequirements = z.infer<typeof RawRequirements>;

export interface RequirementsInput {
  /** What the traveller wrote. Untrusted. */
  message: string;
  /** Today, where the trip starts (YYYY-MM-DD); passed in so results are reproducible. */
  today: string;
  /** What an existing trip already has, when the message is about one. */
  known?: KnownTrip;
}

/** The longest message that is read; the rest is ignored and the outcome says so. */
export const MAX_MESSAGE_CHARS = 2000;

const SYSTEM = `You read a traveller's message and extract what they asked for. You are an extractor, not a planner: you never suggest a trip, choose a route, name a price, or fill in anything the traveller did not say.

For every value you report, "evidence" must be the traveller's own words, copied exactly from the message, that state it. If you cannot quote words that state it, leave it out (null, or omit the item). Never infer: "my wife and I" is not "2 adults" unless a number is stated; "next month" is not a date; "cheap" is not an amount.

Fields:
- origin, destination: the place names as written.
- departureDate, returnDate: only dates the traveller names (a day and a month, or a full date). Report them as YYYY-MM-DD.
- adults, children, infants: whole numbers the traveller states.
- budgetTotalRupees: an amount in rupees the traveller states, as a number. budgetFirm is true only if they say it must not be exceeded, false only if they say it is a rough guide.
- hard: things the traveller requires or rules out ("must", "only", "no", "never", "can't"). kind is one of: excluded_mode, required_mode, avoid_overnight, max_stops, min_hotel_category, accessibility, rooms, latest_arrival, earliest_departure, free_cancellation, dietary.
- soft: things they would like ("prefer", "would be nice", "I like"). kind is one of: priority, preferred_mode, travel_style, amenity, stay_area, activity_interest, pace, cabin_class, party_type.
- Values: transport modes are flight, train, bus, self_drive, rental_car, taxi, ferry. Priorities are cheapest, fastest, most_comfortable, safest, luxury, family_friendly, flexible, scenic, least_travel_time, fewest_transfers. Interests are museums, history, nature, beaches, adventure, religious, shopping, nightlife, family. Times are HH:MM. Counts and star ratings are digits.
- If something is uncertain, choose soft over hard.

${DATA_NOTICE}`;

function unusable(reason: string, rejected: string[]) {
  rejected.push(reason);
}

/** Checks a model's proposal against the message and the domain. */
function sanitise(raw: RawRequirements, input: RequirementsInput): Produced<RequirementsState> {
  const message = input.message.slice(0, MAX_MESSAGE_CHARS);
  const rejected: string[] = [];
  const warnings: string[] = [];
  const draft: RequirementsDraft = {
    origin: null, destination: null, departureDate: null, returnDate: null,
    adults: null, children: null, infants: null,
    budgetRupees: null, budgetFirm: null, hard: [], soft: [],
  };

  const place = (field: 'origin' | 'destination') => {
    const q = raw[field];
    if (!q) return;
    const value = q.value.trim();
    // A place has to be a name the traveller wrote, not one the model supplied.
    if (value.length < 2 || value.length > 80 || !isQuoteOf(value, message) || !isQuoteOf(q.evidence, message)) {
      return unusable(`${field}: not found in the message`, rejected);
    }
    draft[field] = value;
  };
  place('origin');
  place('destination');

  const date = (field: 'departureDate' | 'returnDate') => {
    const q = raw[field];
    if (!q) return;
    if (!isQuoteOf(q.evidence, message)) return unusable(`${field}: quote not found in the message`, rejected);
    // The date is re-read from the quote; the model's own arithmetic is not used.
    const read = findDates(q.evidence, input.today)[0];
    if (!read) return unusable(`${field}: the quote does not name a date`, rejected);
    if (q.value !== read) warnings.push(`${field}: the model's value differed from the quoted date, so the quoted date was used.`);
    draft[field] = read;
  };
  date('departureDate');
  date('returnDate');

  const count = (field: 'adults' | 'children' | 'infants', max: number, min: number) => {
    const q = raw[field];
    if (!q) return;
    const n = q.value;
    if (!Number.isInteger(n) || n < min || n > max) return unusable(`${field}: out of range`, rejected);
    if (!isQuoteOf(q.evidence, message) || !numbersIn(q.evidence).includes(n)) {
      return unusable(`${field}: the quote does not state that number`, rejected);
    }
    draft[field] = n;
  };
  count('adults', 20, 1);
  count('children', 20, 0);
  count('infants', 10, 0);

  if (raw.budgetTotalRupees) {
    const q = raw.budgetTotalRupees;
    const stated = isQuoteOf(q.evidence, message) ? parseRupees(q.evidence) : null;
    if (stated === null || stated !== Math.round(q.value)) {
      unusable('budget: the quote does not state that amount', rejected);
    } else {
      draft.budgetRupees = stated;
    }
  }
  if (raw.budgetFirm) {
    const q = raw.budgetFirm;
    const firmCue = FIRM_CUE;
    const guideCue = GUIDE_CUE;
    if (!isQuoteOf(q.evidence, message)) unusable('budget limit: quote not found in the message', rejected);
    else if (q.value === true && firmCue.test(q.evidence)) draft.budgetFirm = true;
    else if (q.value === false && guideCue.test(q.evidence)) draft.budgetFirm = false;
    else unusable('budget limit: the quote does not say whether it is firm', rejected);
  }

  for (const item of raw.hard.slice(0, 30)) {
    const label = `hard ${item.kind}`;
    if (!(item.kind in HARD_VALUES)) { unusable(`${label}: not a known requirement`, rejected); continue; }
    const kind = item.kind as StatedHard['kind'];
    const value = item.value.trim().toLowerCase();
    if (!HARD_VALUES[kind](value)) { unusable(`${label}: value not allowed`, rejected); continue; }
    if (!isQuoteOf(item.evidence, message)) { unusable(`${label}: quote not found in the message`, rejected); continue; }
    if (!evidenceMentions(kind, value, item.evidence)) { unusable(`${label}: the quote does not mention it`, rejected); continue; }
    draft.hard.push({ kind, value, evidence: item.evidence.trim() });
  }
  for (const item of raw.soft.slice(0, 40)) {
    const label = `soft ${item.kind}`;
    if (!(item.kind in SOFT_VALUES)) { unusable(`${label}: not a known preference`, rejected); continue; }
    const kind = item.kind as StatedSoft['kind'];
    const value = item.value.trim().toLowerCase();
    if (!SOFT_VALUES[kind](value)) { unusable(`${label}: value not allowed`, rejected); continue; }
    if (!isQuoteOf(item.evidence, message)) { unusable(`${label}: quote not found in the message`, rejected); continue; }
    if (!evidenceMentions(kind, value, item.evidence)) { unusable(`${label}: the quote does not mention it`, rejected); continue; }
    draft.soft.push({ kind, value, evidence: item.evidence.trim() });
  }

  if (input.message.length > MAX_MESSAGE_CHARS) warnings.push(`Only the first ${MAX_MESSAGE_CHARS} characters of the message were read.`);
  return { ok: true, data: finalise(draft, input.today, input.known), rejected, warnings };
}

function fallback(input: RequirementsInput): Produced<RequirementsState> {
  const message = input.message.slice(0, MAX_MESSAGE_CHARS);
  const warnings =
    input.message.length > MAX_MESSAGE_CHARS ? [`Only the first ${MAX_MESSAGE_CHARS} characters of the message were read.`] : [];
  return { ok: true, data: finalise(draftFromRules(message, input.today), input.today, input.known), warnings };
}

const spec: AgentSpec<RawRequirements, RequirementsInput, RequirementsState> = {
  name: 'requirements',
  system: SYSTEM,
  schemaName: 'trip_requirements',
  schemaDescription: 'What the traveller asked for, each item with a quote from their message.',
  schema: RawRequirements,
  maxOutputTokens: 1500,
  buildInput: (input) =>
    `Today's date is ${input.today}.\n\n${asData('traveller_message', input.message.slice(0, MAX_MESSAGE_CHARS))}`,
  sanitise,
  fallback,
};

/**
 * Reads a traveller's message. A message with nothing in it is a `missing_data`
 * error, not an empty success: there is nothing to plan from.
 */
export async function runRequirementsAgent(
  input: RequirementsInput,
  ctx: AgentContext,
): Promise<AgentOutcome<RequirementsState>> {
  if (input.message.trim().length === 0) {
    return {
      ok: false,
      error: { code: 'missing_data', message: 'Tell me a little about the trip you have in mind.' },
      meta: { agent: 'requirements', source: 'rules', model: null, durationMs: 0, warnings: [], rejected: [] },
    };
  }
  return runAgent(spec, input, ctx);
}
