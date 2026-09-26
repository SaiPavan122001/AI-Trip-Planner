import {
  Question,
  TravelerProfile,
  nightsBetween,
  seatedTravelers,
  totalTravelers,
  type Answer,
  type JourneyClassification,
  type Money,
  type QuestionInput,
  type QuestionnaireState,
  type TripIntent,
} from '@trip/shared';

/**
 * Adaptive questioning.
 *
 * Questions are declared with a `when` predicate over what is already known.
 * The engine hands back exactly one question at a time, chosen by asking which
 * declared question is both applicable and unanswered. This is what keeps the
 * funnel from turning into a twenty-field form: a solo business traveller is
 * never asked about children's meals, and nobody is asked about rail classes
 * on a trip where rail was excluded at classification.
 *
 * The order of the array is the order of the interview, and it is deliberate:
 * money first (it constrains everything), then style, then the ranking that
 * resolves ties, then the specifics that only matter once a shape is known.
 */

export interface QuestionContext {
  intent: TripIntent;
  classification: JourneyClassification;
  profile: TravelerProfile;
}

interface QuestionDef {
  key: string;
  /** Applicable to this trip at all? */
  when: (ctx: QuestionContext) => boolean;
  /** Needed before a first plan can be produced? */
  requiredForPlanning: boolean;
  build: (ctx: QuestionContext) => QuestionInput;
}

/** Most rooms a single trip may ask for; more than the party is never needed. */
const MAX_ROOMS = 10;
/** Longest free-text location preference accepted, after trimming. */
const LOCATION_MAX_LENGTH = 120;

const nights = (ctx: QuestionContext) =>
  nightsBetween(ctx.intent.departureDate, ctx.intent.returnDate);

const isAnswered = (profile: TravelerProfile, key: string) =>
  profile.answeredKeys.includes(key) || profile.skippedKeys.includes(key);

const DEFS: QuestionDef[] = [
  {
    key: 'budget.total',
    when: () => true,
    requiredForPlanning: true,
    build: (ctx) => ({
      key: 'budget.total',
      kind: 'money',
      prompt: `What is the total budget for this trip, for all ${totalTravelers(ctx.intent.travelers)} traveller(s)?`,
      helpText:
        'Include transport, accommodation and the things you plan to do. The planner treats this as a ceiling and tells you before anything crosses it.',
      options: [],
      min: 0,
      max: null,
      currency: ctx.intent.currency,
      required: true,
      reason:
        'Budget is the one constraint that shapes every other decision, so it is asked first and never quietly exceeded.',
      stage: 'budget',
    }),
  },
  {
    key: 'style.travel_style',
    when: () => true,
    requiredForPlanning: true,
    build: () => ({
      key: 'style.travel_style',
      kind: 'single_choice',
      prompt: 'How would you like this trip to feel?',
      helpText: null,
      options: [
        {
          value: 'budget',
          label: 'Budget',
          description: 'Spend as little as possible; time and comfort give way to price.',
          implication: 'Favours surface transport, hostels and simple rooms.',
        },
        {
          value: 'standard',
          label: 'Standard',
          description: 'Reasonable comfort at a sensible price.',
          implication: 'Typically economy flights and 3-star properties.',
        },
        {
          value: 'premium',
          label: 'Premium',
          description: 'Comfort matters more than the last rupee.',
          implication: 'Typically 4-star and above, direct routings where they exist.',
        },
        {
          value: 'luxury',
          label: 'Luxury',
          description: 'The best available within the budget.',
          implication: 'Premium cabins and 5-star properties, private transfers.',
        },
      ],
      min: null,
      max: null,
      currency: null,
      required: true,
      reason:
        'Travel style sets sensible defaults for dozens of smaller choices so you are not asked about each one.',
      stage: 'style',
    }),
  },
  {
    key: 'priorities.ranking',
    when: () => true,
    requiredForPlanning: true,
    build: (ctx) => ({
      key: 'priorities.ranking',
      kind: 'ranking',
      prompt: 'When two options are close, what should decide it? Put the most important first.',
      helpText: 'Pick up to four. Everything after the first still counts, just less.',
      minSelections: 1,
      maxSelections: 4,
      options: [
        { value: 'cheapest', label: 'Lowest cost', description: null, implication: null },
        { value: 'fastest', label: 'Fastest', description: null, implication: null },
        { value: 'most_comfortable', label: 'Most comfortable', description: null, implication: null },
        { value: 'safest', label: 'Safest', description: null, implication: null },
        { value: 'family_friendly', label: 'Family friendly', description: null, implication: null },
        { value: 'flexible', label: 'Flexible to change', description: null, implication: null },
        {
          value: 'fewest_transfers',
          label: 'Fewest changes',
          description: null,
          implication: null,
        },
        ...(ctx.classification.eligibleModes.some((m) => m === 'train' || m === 'self_drive')
          ? [{ value: 'scenic', label: 'Scenic journey', description: null, implication: null }]
          : []),
      ],
      min: null,
      max: null,
      currency: null,
      required: true,
      reason:
        'Ranking, rather than one "best" answer, is what lets the planner explain why it put one option above another.',
      stage: 'priorities',
    }),
  },
  {
    key: 'transport.mode_openness',
    when: (ctx) =>
      ctx.classification.scope === 'domestic' && ctx.classification.eligibleModes.length > 1,
    requiredForPlanning: false,
    build: (ctx) => ({
      key: 'transport.mode_openness',
      kind: 'multi_choice',
      prompt: 'Which ways of getting there would you consider?',
      helpText:
        'Leave them all selected to compare every option. The planner prices each one before recommending anything.',
      // Ruling out every way of getting there would leave nothing to plan.
      minSelections: 1,
      options: ctx.classification.eligibleModes.map((m) => ({
        value: m,
        label: MODE_LABELS[m] ?? m,
        description: null,
        implication: null,
      })),
      min: null,
      max: null,
      currency: null,
      required: false,
      reason:
        'Ruling a mode out now saves searching it; leaving it in costs nothing but a moment of search time.',
      stage: 'transport',
    }),
  },
  {
    key: 'transport.cabin_class',
    when: (ctx) => ctx.classification.eligibleModes.includes('flight'),
    requiredForPlanning: false,
    build: () => ({
      key: 'transport.cabin_class',
      kind: 'single_choice',
      prompt: 'Which cabin should flights be searched in?',
      helpText: 'Only cabins the airline actually sells on a route will be offered.',
      options: [
        { value: 'economy', label: 'Economy', description: null, implication: null },
        { value: 'premium_economy', label: 'Premium economy', description: null, implication: null },
        { value: 'business', label: 'Business', description: null, implication: null },
        { value: 'first', label: 'First', description: null, implication: null },
      ],
      min: null,
      max: null,
      currency: null,
      required: false,
      reason: 'Cabin changes the price by a multiple, so it is asked rather than assumed.',
      stage: 'transport',
    }),
  },
  {
    key: 'transport.baggage',
    when: (ctx) => ctx.classification.eligibleModes.includes('flight'),
    requiredForPlanning: false,
    build: () => ({
      key: 'transport.baggage',
      kind: 'number',
      prompt: 'How many checked bags per traveller?',
      helpText:
        'Checked bags are priced separately on many fares. Telling the planner now keeps the total honest.',
      options: [],
      min: 0,
      max: 5,
      currency: null,
      required: false,
      reason:
        'A fare that looks cheapest often stops being cheapest once two checked bags are added.',
      stage: 'transport',
    }),
  },
  {
    key: 'transport.overnight',
    when: (ctx) =>
      ctx.classification.eligibleModes.some((m) => m === 'train' || m === 'bus') ||
      ctx.classification.greatCircleKm > 2500,
    requiredForPlanning: false,
    build: () => ({
      key: 'transport.overnight',
      kind: 'boolean',
      prompt: 'Is overnight travel acceptable?',
      helpText: 'Overnight legs save a night of accommodation but cost a night of sleep.',
      options: [],
      min: null,
      max: null,
      currency: null,
      required: false,
      reason:
        'This decides whether the planner may use night trains, red-eye flights and sleeper coaches.',
      stage: 'transport',
    }),
  },
  {
    key: 'accommodation.type',
    when: (ctx) => nights(ctx) > 0,
    requiredForPlanning: true,
    build: () => ({
      key: 'accommodation.type',
      kind: 'multi_choice',
      prompt: 'What kind of place would you like to stay in?',
      helpText: null,
      minSelections: 1,
      options: [
        { value: 'hotel', label: 'Hotel', description: null, implication: null },
        { value: 'hostel', label: 'Hostel', description: null, implication: null },
        { value: 'resort', label: 'Resort', description: null, implication: null },
        { value: 'villa', label: 'Villa', description: null, implication: null },
        { value: 'apartment', label: 'Apartment', description: null, implication: null },
        { value: 'guesthouse', label: 'Guesthouse', description: null, implication: null },
      ],
      min: null,
      max: null,
      currency: null,
      required: false,
      reason: 'Property type changes which providers are searched and what a "room" even means.',
      stage: 'accommodation',
    }),
  },
  {
    key: 'accommodation.category',
    when: (ctx) => nights(ctx) > 0,
    requiredForPlanning: false,
    build: () => ({
      key: 'accommodation.category',
      kind: 'single_choice',
      prompt: 'Is there a minimum standard the property must meet?',
      helpText: 'Ratings come from the provider; unrated properties are labelled as such.',
      options: [
        { value: '0', label: 'No minimum', description: null, implication: null },
        { value: '3', label: '3-star or above', description: null, implication: null },
        { value: '4', label: '4-star or above', description: null, implication: null },
        { value: '5', label: '5-star only', description: null, implication: null },
      ],
      min: null,
      max: null,
      currency: null,
      required: false,
      reason: 'This is treated as a hard filter, so nothing below it is ever shown to you.',
      stage: 'accommodation',
    }),
  },
  {
    key: 'accommodation.rooms',
    when: (ctx) => nights(ctx) > 0 && seatedTravelers(ctx.intent.travelers) > 1,
    requiredForPlanning: true,
    build: (ctx) => ({
      key: 'accommodation.rooms',
      kind: 'number',
      prompt: `How many rooms do you need for ${seatedTravelers(ctx.intent.travelers)} people?`,
      helpText: 'Room count is a hard requirement: the planner will not quietly put four people in one double.',
      options: [],
      min: 1,
      // More rooms than people is never a real requirement.
      max: Math.min(MAX_ROOMS, seatedTravelers(ctx.intent.travelers)),
      currency: null,
      required: true,
      reason: 'Occupancy rules differ by property, so the number of rooms is asked rather than derived.',
      stage: 'accommodation',
    }),
  },
  {
    key: 'accommodation.cancellation',
    when: (ctx) => nights(ctx) > 0,
    requiredForPlanning: false,
    build: () => ({
      key: 'accommodation.cancellation',
      kind: 'boolean',
      prompt: 'Do you need free cancellation?',
      helpText: 'Flexible rates usually cost more. The planner shows the difference before you choose.',
      options: [],
      min: null,
      max: null,
      currency: null,
      required: false,
      reason:
        'Cancellation terms are a hard filter when required, and the planner will not substitute a non-refundable rate to hit a price.',
      stage: 'accommodation',
    }),
  },
  {
    key: 'accommodation.location',
    when: (ctx) => nights(ctx) > 0,
    requiredForPlanning: false,
    build: (ctx) => ({
      key: 'accommodation.location',
      kind: 'text',
      prompt: `Whereabouts in ${ctx.intent.destination.name} would you like to be?`,
      helpText: 'For example "near the centre", "close to the station", or a neighbourhood name.',
      maxLength: LOCATION_MAX_LENGTH,
      options: [],
      min: null,
      max: null,
      currency: null,
      required: false,
      reason:
        'Where you stay decides what you spend on local transport, which the planner counts as part of the hotel decision.',
      stage: 'accommodation',
    }),
  },
  {
    key: 'traveler.party_type',
    when: () => true,
    requiredForPlanning: false,
    build: () => ({
      key: 'traveler.party_type',
      kind: 'single_choice',
      prompt: 'Who is travelling?',
      helpText: null,
      options: [
        { value: 'solo', label: 'Just me', description: null, implication: null },
        { value: 'couple', label: 'A couple', description: null, implication: null },
        { value: 'family', label: 'A family', description: null, implication: null },
        { value: 'friends', label: 'Friends', description: null, implication: null },
        { value: 'group', label: 'A larger group', description: null, implication: null },
        { value: 'business_team', label: 'Colleagues', description: null, implication: null },
      ],
      min: null,
      max: null,
      currency: null,
      required: false,
      reason: 'Party shape changes which trade-offs matter, from room configuration to pacing.',
      stage: 'traveler_needs',
    }),
  },
  {
    key: 'traveler.accessibility',
    // Asked of everyone. Needing step-free access or a hearing loop has
    // nothing to do with party size or age, and gating the question on
    // either meant a solo traveller using a wheelchair was never asked.
    when: () => true,
    requiredForPlanning: false,
    build: () => ({
      key: 'traveler.accessibility',
      kind: 'multi_choice',
      prompt: 'Does anyone travelling need accessibility support?',
      helpText:
        'Choose any that apply, or continue with none selected. Each one is treated as a requirement: only places that publish that they meet it are included, and the planner says plainly when a provider does not publish enough to confirm it.',
      options: [
        { value: 'step_free_access', label: 'Step-free access', description: null, implication: null },
        {
          value: 'wheelchair_accessible_room',
          label: 'Wheelchair-accessible room',
          description: null,
          implication: null,
        },
        { value: 'accessible_bathroom', label: 'Accessible bathroom', description: null, implication: null },
        {
          value: 'wheelchair_assistance_at_terminal',
          label: 'Assistance at airports and stations',
          description: null,
          implication: null,
        },
        { value: 'elevator_required', label: 'Lift required', description: null, implication: null },
        { value: 'ground_floor_room', label: 'Ground-floor room', description: null, implication: null },
        { value: 'service_animal', label: 'Travelling with a service animal', description: null, implication: null },
        { value: 'visual_assistance', label: 'Support for visual impairment', description: null, implication: null },
        { value: 'hearing_assistance', label: 'Support for hearing impairment', description: null, implication: null },
      ],
      minSelections: 0,
      min: null,
      max: null,
      currency: null,
      required: false,
      reason:
        'Accessibility is a hard requirement. It is asked of everyone because inferring it from anything else would be guesswork.',
      stage: 'traveler_needs',
    }),
  },
  {
    key: 'traveler.children_needs',
    when: (ctx) => ctx.intent.travelers.children > 0 || ctx.intent.travelers.infants > 0,
    requiredForPlanning: false,
    build: (ctx) => ({
      key: 'traveler.children_needs',
      kind: 'multi_choice',
      prompt: `What do you need for the ${ctx.intent.travelers.children + ctx.intent.travelers.infants} younger traveller(s)?`,
      helpText: null,
      options: [
        { value: 'cot', label: 'Cot or crib', description: null, implication: null },
        { value: 'extra_bed', label: 'Extra bed', description: null, implication: null },
        { value: 'stroller_space', label: 'Room for a pushchair', description: null, implication: null },
        { value: 'short_travel_days', label: 'Shorter travel days', description: null, implication: null },
        { value: 'child_meals', label: 'Child meals on board', description: null, implication: null },
      ],
      min: null,
      max: null,
      currency: null,
      required: false,
      reason:
        'These change both the room search and how tightly the days can be scheduled.',
      stage: 'traveler_needs',
    }),
  },
  {
    key: 'traveler.dietary',
    when: (ctx) =>
      ctx.classification.scope === 'international' || totalTravelers(ctx.intent.travelers) > 2,
    requiredForPlanning: false,
    build: () => ({
      key: 'traveler.dietary',
      kind: 'multi_choice',
      prompt: 'Any dietary requirements the planner should keep in mind?',
      helpText:
        'Used for on-board meal requests where the carrier supports them, and when suggesting places to eat.',
      options: [
        { value: 'vegetarian', label: 'Vegetarian', description: null, implication: null },
        { value: 'vegan', label: 'Vegan', description: null, implication: null },
        { value: 'jain', label: 'Jain', description: null, implication: null },
        { value: 'halal', label: 'Halal', description: null, implication: null },
        { value: 'kosher', label: 'Kosher', description: null, implication: null },
        { value: 'gluten_free', label: 'Gluten free', description: null, implication: null },
        { value: 'nut_allergy', label: 'Nut allergy', description: null, implication: null },
      ],
      min: null,
      max: null,
      currency: null,
      required: false,
      reason: 'Meal requests must be made at booking time, not after tickets are issued.',
      stage: 'traveler_needs',
    }),
  },
  {
    key: 'budget.daily_spend',
    when: (ctx) => nights(ctx) > 0,
    requiredForPlanning: false,
    build: (ctx) => ({
      key: 'budget.daily_spend',
      kind: 'money',
      prompt: 'Roughly how much per person, per day, for food and getting around locally?',
      helpText:
        'This is carried into the total so the budget you see is the budget you will actually spend.',
      options: [],
      min: 0,
      max: null,
      currency: ctx.intent.currency,
      required: false,
      reason:
        'Daily spending is usually the largest line item nobody plans for, and leaving it out is how trips quietly go over budget.',
      stage: 'budget',
    }),
  },
];

const MODE_LABELS: Record<string, string> = {
  flight: 'Flight',
  train: 'Train',
  bus: 'Bus',
  self_drive: 'Drive my own car',
  rental_car: 'Rental car',
  taxi: 'Private car or taxi',
  ferry: 'Ferry',
};

export function applicableQuestions(ctx: QuestionContext): QuestionDef[] {
  return DEFS.filter((d) => d.when(ctx));
}

/** The single next question, or null when the interview is done. */
export function nextQuestion(ctx: QuestionContext): Question | null {
  const def = applicableQuestions(ctx).find((d) => !isAnswered(ctx.profile, d.key));
  return def ? Question.parse(def.build(ctx)) : null;
}

export function questionnaireState(ctx: QuestionContext): QuestionnaireState {
  const applicable = applicableQuestions(ctx);
  const answered = applicable.filter((d) => isAnswered(ctx.profile, d.key));
  const missingRequired = applicable.filter(
    (d) => d.requiredForPlanning && !isAnswered(ctx.profile, d.key),
  );
  const next = nextQuestion(ctx);
  return {
    next,
    asked: ctx.profile.answeredKeys,
    completeness: applicable.length === 0 ? 1 : Number((answered.length / applicable.length).toFixed(2)),
    canPlan: missingRequired.length === 0,
  };
}

// ------------------------------------------------------------ answers

/**
 * An answer that failed validation. The message is written for a traveller
 * and is safe to show; it never echoes the rejected value back.
 */
export class AnswerValidationError extends Error {
  constructor(
    readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = 'AnswerValidationError';
  }
}

/** An answer whose value has been checked against the question it answers. */
export type ValidatedAnswer =
  | { key: string; skipped: true; value: null }
  | { key: string; skipped: false; value: string | number | boolean | string[] | Money | null };

// Free text is stored as a single line: newlines and tabs are collapsed to
// spaces (a pasted line break is not an error), and any other control
// character, such as NUL or a terminal escape, is refused because no real
// place description contains one.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Checks an answer against the question as it is actually asked for this
 * trip: its kind, its options, its limits and its currency. Every rule comes
 * from the built `Question`, which is also what the client renders, so the
 * UI and the server cannot disagree about what is allowed.
 *
 * Nothing here trusts the TypeScript type of `answer.value`: it arrives from
 * an HTTP body, and later from a model, and is treated as untrusted either
 * way.
 */
export function validateAnswer(ctx: QuestionContext, answer: Answer): ValidatedAnswer {
  const def = DEFS.find((d) => d.key === answer.key);
  if (!def) throw new AnswerValidationError(answer.key, `Unknown question key: ${answer.key}`);
  if (!def.when(ctx)) {
    throw new AnswerValidationError(answer.key, 'That question does not apply to this trip.');
  }
  const question = Question.parse(def.build(ctx));

  if (answer.skipped) {
    // `required` is what the traveller is shown ("needed before a plan can be
    // built", no Skip button), so it is also what decides whether a skip is
    // accepted. A question that is needed for planning but not required
    // (accommodation type) may be skipped, and planning uses its default.
    if (question.required) {
      throw new AnswerValidationError(
        answer.key,
        'This question has to be answered before a plan can be built, so it cannot be skipped.',
      );
    }
    return { key: answer.key, skipped: true, value: null };
  }

  const v: unknown = answer.value;
  if (v === null || v === undefined) {
    throw new AnswerValidationError(answer.key, 'Please give an answer, or skip the question.');
  }
  const optionValues = new Set(question.options.map((o) => o.value));
  const fail = (message: string): never => {
    throw new AnswerValidationError(answer.key, message);
  };

  switch (question.kind) {
    case 'single_choice': {
      if (typeof v !== 'string' || !optionValues.has(v)) fail('Please choose one of the options offered.');
      return { key: answer.key, skipped: false, value: v as string };
    }
    case 'multi_choice':
    case 'ranking': {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        fail('Please choose from the options offered.');
      }
      const chosen = v as string[];
      if (new Set(chosen).size !== chosen.length) fail('Each option can only be chosen once.');
      if (chosen.some((x) => !optionValues.has(x))) fail('Please choose from the options offered.');
      const min = question.minSelections ?? 0;
      const max = question.maxSelections ?? question.options.length;
      if (chosen.length < min) {
        fail(min === 1 ? 'Please choose at least one option.' : `Please choose at least ${min} options.`);
      }
      if (chosen.length > max) fail(`Please choose no more than ${max}.`);
      return { key: answer.key, skipped: false, value: chosen };
    }
    case 'number': {
      if (typeof v !== 'number' || !Number.isInteger(v)) fail('Please enter a whole number.');
      const n = v as number;
      if ((question.min !== null && n < question.min) || (question.max !== null && n > question.max)) {
        fail(`Please enter a number from ${question.min ?? 0} to ${question.max ?? n}.`);
      }
      return { key: answer.key, skipped: false, value: n };
    }
    case 'money': {
      const m = v as Partial<Money>;
      if (typeof v !== 'object' || Array.isArray(v) || typeof m.amount !== 'number' || typeof m.currency !== 'string') {
        fail('Please enter an amount.');
      }
      if (m.currency !== question.currency) {
        fail(`Amounts for this trip are in ${question.currency}.`);
      }
      // Minor units must be exact integers well inside the range where a
      // JavaScript number is exact, or totals silently lose paise.
      if (!Number.isSafeInteger(m.amount) || (m.amount as number) <= 0) {
        fail('Please enter an amount greater than zero.');
      }
      return {
        key: answer.key,
        skipped: false,
        value: { amount: m.amount as number, currency: m.currency as string },
      };
    }
    case 'boolean': {
      if (typeof v !== 'boolean') fail('Please answer yes or no.');
      return { key: answer.key, skipped: false, value: v as boolean };
    }
    case 'text': {
      if (typeof v !== 'string') fail('Please enter some text.');
      const text = (v as string).trim().replace(/\s+/g, ' ');
      if (CONTROL_CHARS.test(text)) fail('That answer contains characters that are not allowed.');
      if (question.maxLength !== null && text.length > question.maxLength) {
        fail(`Please keep this to ${question.maxLength} characters.`);
      }
      // An empty text answer is a real answer ("no preference"), not a skip.
      return { key: answer.key, skipped: false, value: text === '' ? null : text };
    }
    case 'time':
    default:
      return fail('This kind of question cannot be answered here.');
  }
}

/**
 * Validates an answer and applies it to the profile. Unknown keys and values
 * outside what the question offers are rejected rather than stored, so a
 * malformed or model-generated answer cannot smuggle a value into the profile
 * that later code might trust, or that would make the stored trip unreadable.
 *
 * Skipping resets the field to its default: a skipped question leaves no
 * trace of a preference, including one given earlier and then withdrawn.
 */
export function applyAnswer(
  ctx: QuestionContext,
  raw: Answer,
): { profile: TravelerProfile; answer: ValidatedAnswer } {
  const answer = validateAnswer(ctx, raw);
  const next: TravelerProfile = structuredClone(ctx.profile);
  const blank = TravelerProfile.parse({});

  next.answeredKeys = next.answeredKeys.filter((k) => k !== answer.key);
  next.skippedKeys = next.skippedKeys.filter((k) => k !== answer.key);

  const v = answer.value;
  switch (answer.key) {
    case 'style.travel_style':
      next.travelStyle = answer.skipped ? blank.travelStyle : (v as TravelerProfile['travelStyle']);
      break;
    case 'priorities.ranking':
      next.priorities = answer.skipped ? blank.priorities : (v as TravelerProfile['priorities']);
      break;
    case 'transport.mode_openness': {
      if (answer.skipped) {
        next.transport.excludedModes = blank.transport.excludedModes;
      } else {
        const chosen = new Set(v as string[]);
        next.transport.excludedModes = Object.keys(MODE_LABELS).filter((m) => !chosen.has(m));
      }
      break;
    }
    case 'transport.cabin_class':
      next.transport.cabinClass = answer.skipped
        ? blank.transport.cabinClass
        : (v as TravelerProfile['transport']['cabinClass']);
      break;
    case 'transport.baggage':
      next.transport.checkedBagsPerTraveler = answer.skipped
        ? blank.transport.checkedBagsPerTraveler
        : (v as number);
      break;
    case 'transport.overnight':
      next.transport.avoidOvernightTravel = answer.skipped
        ? blank.transport.avoidOvernightTravel
        : v === false;
      break;
    case 'accommodation.type':
      next.accommodation.types = answer.skipped
        ? blank.accommodation.types
        : (v as TravelerProfile['accommodation']['types']);
      break;
    case 'accommodation.category':
      next.accommodation.minCategory = answer.skipped ? blank.accommodation.minCategory : Number(v) || null;
      break;
    case 'accommodation.rooms':
      next.accommodation.rooms = answer.skipped ? blank.accommodation.rooms : (v as number);
      break;
    case 'accommodation.cancellation':
      next.accommodation.freeCancellationRequired = answer.skipped
        ? blank.accommodation.freeCancellationRequired
        : v === true;
      break;
    case 'accommodation.location':
      next.accommodation.locationPreference = answer.skipped
        ? blank.accommodation.locationPreference
        : (v as string | null);
      break;
    case 'traveler.party_type':
      next.partyType = answer.skipped ? blank.partyType : (v as TravelerProfile['partyType']);
      break;
    case 'traveler.accessibility':
      next.special.accessibility = answer.skipped
        ? blank.special.accessibility
        : (v as TravelerProfile['special']['accessibility']);
      break;
    case 'traveler.children_needs':
      next.special.assistanceNotes = answer.skipped ? blank.special.assistanceNotes : (v as string[]);
      break;
    case 'traveler.dietary':
      next.special.dietary = answer.skipped
        ? blank.special.dietary
        : (v as TravelerProfile['special']['dietary']);
      break;
    case 'budget.total':
    case 'budget.daily_spend':
      // Budget answers are money and live on the constraint set, not the
      // profile; the caller passes the validated value to `buildConstraints`.
      break;
    default:
      throw new AnswerValidationError(answer.key, `Question ${answer.key} has no handler`);
  }

  (answer.skipped ? next.skippedKeys : next.answeredKeys).push(answer.key);

  // Last line of defence: whatever the switch above wrote must still be a
  // valid profile, or it is not stored at all.
  return { profile: TravelerProfile.parse(next), answer };
}

export const QUESTION_KEYS = DEFS.map((d) => d.key);
