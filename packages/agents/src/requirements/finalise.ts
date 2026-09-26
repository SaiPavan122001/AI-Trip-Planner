import {
  money,
  type StatedHard,
  type MissingField,
  type RequirementsState,
  type StatedSoft,
} from '@trip/shared';

/**
 * What the Requirements Agent (or its fallback) proposed, after every value
 * has been checked, and before the deterministic completion below. Nothing in
 * a draft is a claim about what is missing: that is worked out here, so a model
 * cannot make a gap disappear by not mentioning it.
 */
export interface RequirementsDraft {
  origin: string | null;
  destination: string | null;
  departureDate: string | null;
  returnDate: string | null;
  adults: number | null;
  children: number | null;
  infants: number | null;
  budgetRupees: number | null;
  budgetFirm: boolean | null;
  hard: StatedHard[];
  soft: StatedSoft[];
}

/** What the trip already has, when requirements are being read against an existing trip. */
export interface KnownTrip {
  origin?: string | null;
  destination?: string | null;
  departureDate?: string | null;
  returnDate?: string | null;
  adults?: number | null;
}

export const QUESTIONS: Record<MissingField, string> = {
  origin: 'Where are you travelling from?',
  destination: 'Where would you like to go?',
  departure_date: 'What date do you want to leave? For example, 12 December.',
  travelers: 'How many people are travelling?',
};

const same = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

function unique<T extends { kind: string; value: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = `${i.kind}:${i.value}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

/**
 * Turns a checked draft into a `RequirementsState`: works out, in code, what
 * is still missing and what contradicts what.
 */
export function finalise(draft: RequirementsDraft, today: string, known: KnownTrip = {}): RequirementsState {
  const hard = unique(draft.hard);
  const soft = unique(draft.soft);

  const origin = draft.origin ?? known.origin ?? null;
  const destination = draft.destination ?? known.destination ?? null;
  const departureDate = draft.departureDate ?? known.departureDate ?? null;
  const returnDate = draft.returnDate ?? known.returnDate ?? null;
  const adults = draft.adults ?? known.adults ?? null;
  const travelers =
    adults === null
      ? null
      : { adults, children: draft.children ?? 0, infants: draft.infants ?? 0 };

  const missing: RequirementsState['missing'] = [];
  const need = (field: MissingField, present: boolean) => {
    if (!present) missing.push({ field, question: QUESTIONS[field] });
  };
  need('origin', Boolean(origin));
  need('destination', Boolean(destination));
  need('departure_date', Boolean(departureDate));
  need('travelers', adults !== null);

  const conflicts: RequirementsState['conflicts'] = [];
  const conflict = (fields: string[], message: string) => conflicts.push({ fields, message });

  if (departureDate && departureDate < today) {
    conflict(['departure_date'], `The departure date ${departureDate} has already passed.`);
  }
  if (departureDate && returnDate && returnDate < departureDate) {
    conflict(['departure_date', 'return_date'], 'The return date is before the departure date.');
  }
  if (same(origin, destination)) {
    conflict(['origin', 'destination'], 'The trip starts and ends in the same place.');
  }
  const excluded = new Set(hard.filter((h) => h.kind === 'excluded_mode').map((h) => h.value));
  const required = hard.filter((h) => h.kind === 'required_mode').map((h) => h.value);
  for (const mode of required) {
    if (excluded.has(mode)) {
      conflict(['excluded_mode', 'required_mode'], `You asked both for and against travelling by ${mode.replace('_', ' ')}.`);
    }
  }
  if (new Set(required).size > 1) {
    conflict(['required_mode'], 'You asked for more than one way of travelling as the only one.');
  }
  const rooms = hard.find((h) => h.kind === 'rooms');
  if (rooms && travelers && Number(rooms.value) > travelers.adults + travelers.children) {
    conflict(['rooms', 'travelers'], 'You asked for more rooms than there are people travelling.');
  }
  if (draft.budgetFirm === true && draft.budgetRupees === null) {
    conflict(['budget'], 'You said the budget is a limit but did not say what it is.');
  }
  const arrival = hard.find((h) => h.kind === 'latest_arrival');
  const departure = hard.find((h) => h.kind === 'earliest_departure');
  if (arrival && departure && arrival.value < departure.value) {
    conflict(['latest_arrival', 'earliest_departure'], 'The latest arrival you asked for is before the earliest departure.');
  }

  return {
    trip: { origin, destination, departureDate, returnDate, travelers },
    budget: {
      total: draft.budgetRupees === null ? null : money(draft.budgetRupees, 'INR'),
      firm: draft.budgetFirm,
    },
    hard,
    soft,
    missing,
    conflicts,
    complete: missing.length === 0 && conflicts.length === 0,
  };
}

/**
 * The body `POST /v1/trips` takes, when the requirements name everything a
 * trip needs and nothing contradicts. Null otherwise: a partial trip is never
 * assembled by guessing the rest.
 */
export function toTripInput(state: RequirementsState): {
  originQuery: string;
  destinationQuery: string;
  departureDate: string;
  returnDate: string | null;
  travelers: { adults: number; children: number; infants: number };
} | null {
  const { origin, destination, departureDate, returnDate, travelers } = state.trip;
  if (!state.complete || !origin || !destination || !departureDate || !travelers) return null;
  return { originQuery: origin, destinationQuery: destination, departureDate, returnDate, travelers };
}

/**
 * Combines what was said before with what has just been said. For each kind of
 * requirement the latest message replaces the earlier one (someone who says
 * "actually, trains are fine" is not held to "no trains"), and a requirement of
 * a kind the new message does not mention is kept. Trip facts and the budget
 * take the new value when there is one.
 */
export function mergeRequirements(previous: RequirementsState | null, next: RequirementsState): RequirementsState {
  if (!previous) return next;
  const nextHard = new Set(next.hard.map((h) => h.kind));
  const nextSoft = new Set(next.soft.map((s) => s.kind));
  return {
    trip: {
      origin: next.trip.origin ?? previous.trip.origin,
      destination: next.trip.destination ?? previous.trip.destination,
      departureDate: next.trip.departureDate ?? previous.trip.departureDate,
      returnDate: next.trip.returnDate ?? previous.trip.returnDate,
      travelers: next.trip.travelers ?? previous.trip.travelers,
    },
    budget: {
      total: next.budget.total ?? previous.budget.total,
      firm: next.budget.firm ?? previous.budget.firm,
    },
    hard: [...previous.hard.filter((h) => !nextHard.has(h.kind)), ...next.hard],
    soft: [...previous.soft.filter((s) => !nextSoft.has(s.kind)), ...next.soft],
    missing: next.missing,
    conflicts: next.conflicts,
    complete: next.complete,
  };
}
