import { describe, expect, it } from 'vitest';
import { classifyJourney } from '../classify.js';
import type { Question } from '@trip/shared';
import { AnswerValidationError, applyAnswer, nextQuestion, questionnaireState } from '../questioner.js';
import { bengaluru, hyderabad, intent, paris, profile } from './fixtures.js';

const ctxFor = (tripIntent = intent(), travelerProfile = profile()) => ({
  intent: tripIntent,
  classification: classifyJourney(tripIntent.origin, tripIntent.destination),
  profile: travelerProfile,
});

describe('adaptive questioning', () => {
  it('asks about budget first, because it constrains everything else', () => {
    expect(nextQuestion(ctxFor())?.key).toBe('budget.total');
  });

  it('never asks the same question twice', () => {
    const ctx = ctxFor();
    const { profile: answered } = applyAnswer(ctx, {
      key: 'style.travel_style',
      value: 'premium',
      skipped: false,
    });
    const keys = askEverything({ ...ctx, profile: answered });
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain('style.travel_style');
  });

  it('does not ask about children when nobody under 18 is travelling', () => {
    const keys = askEverything(ctxFor());
    expect(keys).not.toContain('traveler.children_needs');
  });

  it('asks about children when they are in the party', () => {
    const withKids = intent({ travelers: { adults: 2, children: 1, infants: 1 } });
    expect(askEverything(ctxFor(withKids))).toContain('traveler.children_needs');
  });

  it('only offers a mode choice when more than one mode is possible', () => {
    // Hyderabad to Paris is a flight problem; asking which mode to consider
    // would be a meaningless question.
    const international = intent({ destination: paris, destinationQuery: 'Paris' });
    expect(askEverything(ctxFor(international))).not.toContain('transport.mode_openness');
    expect(askEverything(ctxFor())).toContain('transport.mode_openness');
  });

  it('skips accommodation questions entirely for a day trip', () => {
    const dayTrip = intent({ returnDate: null });
    const keys = askEverything(ctxFor(dayTrip));
    expect(keys.filter((k) => k.startsWith('accommodation.'))).toEqual([]);
  });

  it('asks for a room count only when more than one person is travelling', () => {
    const solo = intent({ travelers: { adults: 1, children: 0, infants: 0 } });
    expect(askEverything(ctxFor(solo))).not.toContain('accommodation.rooms');
    expect(askEverything(ctxFor())).toContain('accommodation.rooms');
  });

  it('will not plan until the required answers exist', () => {
    expect(questionnaireState(ctxFor()).canPlan).toBe(false);
  });

  it('records a skip without mistaking it for an answer', () => {
    const { profile: skipped } = applyAnswer(ctxFor(), {
      key: 'accommodation.category',
      value: null,
      skipped: true,
    });
    expect(skipped.skippedKeys).toContain('accommodation.category');
    expect(skipped.answeredKeys).not.toContain('accommodation.category');
    // A skipped question must leave no trace of a preference.
    expect(skipped.accommodation.minCategory).toBeNull();
  });

  it('rejects an answer to a question it does not know', () => {
    expect(() =>
      applyAnswer(ctxFor(), { key: 'not.a.question', value: 'x', skipped: false }),
    ).toThrow(/Unknown question key/);
  });

  it('turns a mode selection into exclusions for everything unselected', () => {
    const { profile: updated } = applyAnswer(ctxFor(), {
      key: 'transport.mode_openness',
      value: ['flight', 'train'],
      skipped: false,
    });
    expect(updated.transport.excludedModes).toContain('bus');
    expect(updated.transport.excludedModes).not.toContain('flight');
  });

  it('records "overnight is fine" as not avoiding overnight travel', () => {
    const yes = applyAnswer(ctxFor(), { key: 'transport.overnight', value: true, skipped: false });
    const no = applyAnswer(ctxFor(), { key: 'transport.overnight', value: false, skipped: false });
    expect(yes.profile.transport.avoidOvernightTravel).toBe(false);
    expect(no.profile.transport.avoidOvernightTravel).toBe(true);
  });
});

describe('answer validation', () => {
  // Every rejection names the rule it expects, so a test cannot pass because
  // the answer was refused for some other reason.
  const reject = (key: string, value: unknown, message: RegExp, ctx = ctxFor()) => {
    const attempt = () => applyAnswer(ctx, { key, value: value as never, skipped: false });
    expect(attempt).toThrow(AnswerValidationError);
    expect(attempt).toThrow(message);
  };
  // The dietary question is only asked of larger or international parties.
  const group = () => ctxFor(intent({ travelers: { adults: 3, children: 0, infants: 0 } }));

  it('rejects a value that is not one of the options offered', () => {
    reject('style.travel_style', 'foo', /choose one of the options/);
    reject('transport.cabin_class', 'cargo_hold', /choose one of the options/);
    reject('traveler.party_type', 42, /choose one of the options/);
  });

  it('rejects a list containing anything not offered, or the same option twice', () => {
    reject('traveler.dietary', ['vegetarian', 'raw_meat_only'], /choose from the options/, group());
    reject('priorities.ranking', ['cheapest', 'cheapest'], /only be chosen once/);
    reject('priorities.ranking', 'cheapest', /choose from the options/);
    reject('accommodation.type', [{ $gt: '' }], /choose from the options/);
  });

  it('enforces how many options may be chosen', () => {
    reject('priorities.ranking', [], /at least one/);
    reject('priorities.ranking', ['cheapest', 'fastest', 'safest', 'flexible', 'most_comfortable'], /no more than 4/);
    // Ruling out every mode would leave nothing to plan.
    reject('transport.mode_openness', [], /at least one/);
    reject('accommodation.type', [], /at least one/);
  });

  it('accepts an explicit "none of these" where that is a real answer', () => {
    const { profile: updated } = applyAnswer(group(), {
      key: 'traveler.dietary',
      value: [],
      skipped: false,
    });
    expect(updated.special.dietary).toEqual([]);
    expect(updated.answeredKeys).toContain('traveler.dietary');
  });

  it('rejects numbers that are fractional, out of range or not numbers at all', () => {
    reject('transport.baggage', 1.5, /whole number/);
    reject('transport.baggage', -1, /from 0 to 5/);
    reject('transport.baggage', 99, /from 0 to 5/);
    reject('transport.baggage', '2', /whole number/);
    reject('accommodation.rooms', 0, /from 1 to 2/);
  });

  it('never allows more rooms than people', () => {
    // Two travellers in the fixture.
    reject('accommodation.rooms', 3, /from 1 to 2/);
    expect(applyAnswer(ctxFor(), { key: 'accommodation.rooms', value: 2, skipped: false }).profile.accommodation.rooms).toBe(2);
  });

  it('rejects money in another currency, of zero, negative, fractional or unsafe size', () => {
    reject('budget.total', { amount: 5000000, currency: 'USD' }, /are in INR/);
    reject('budget.total', { amount: 0, currency: 'INR' }, /greater than zero/);
    reject('budget.total', { amount: -100, currency: 'INR' }, /greater than zero/);
    reject('budget.total', { amount: 10.5, currency: 'INR' }, /greater than zero/);
    reject('budget.total', { amount: Number.MAX_SAFE_INTEGER + 2, currency: 'INR' }, /greater than zero/);
    reject('budget.total', 50000, /enter an amount/);
  });

  it('rejects over-long or control-character text, and normalises whitespace', () => {
    reject('accommodation.location', 'x'.repeat(121), /120 characters/);
    reject('accommodation.location', 'near the centre\u0000', /not allowed/);
    reject('accommodation.location', 'near \u001b[2Jthe centre', /not allowed/);
    const { profile: updated } = applyAnswer(ctxFor(), {
      key: 'accommodation.location',
      value: '  near   the\r\n station\t',
      skipped: false,
    });
    // Stored as a single line, whatever was pasted.
    expect(updated.accommodation.locationPreference).toBe('near the station');
  });

  it('rejects answers to questions that do not apply to this trip', () => {
    const dayTrip = ctxFor(intent({ returnDate: null }));
    reject('accommodation.rooms', 1, /does not apply/, dayTrip);
  });

  it('refuses to skip a question the traveller is told is required', () => {
    expect(() => applyAnswer(ctxFor(), { key: 'budget.total', value: null, skipped: true })).toThrow(
      /cannot be skipped/,
    );
  });

  it('lets an optional question that has a sensible default be skipped', () => {
    // Accommodation type is needed to plan, but defaults to "hotel".
    const { profile: skipped } = applyAnswer(ctxFor(), {
      key: 'accommodation.type',
      value: null,
      skipped: true,
    });
    expect(skipped.accommodation.types).toEqual(['hotel']);
  });

  it('refuses an empty answer that is not a skip', () => {
    reject('style.travel_style', null, /give an answer/);
  });

  it('forgets an earlier answer when the question is later skipped', () => {
    const first = applyAnswer(ctxFor(), { key: 'transport.cabin_class', value: 'business', skipped: false });
    const { profile: skipped } = applyAnswer(
      { ...ctxFor(), profile: first.profile },
      { key: 'transport.cabin_class', value: null, skipped: true },
    );
    expect(skipped.transport.cabinClass).toBeNull();
    expect(skipped.answeredKeys).not.toContain('transport.cabin_class');
    expect(skipped.skippedKeys).toContain('transport.cabin_class');
  });

  it('stops counting a question as skipped once it is answered', () => {
    const first = applyAnswer(ctxFor(), { key: 'transport.cabin_class', value: null, skipped: true });
    const { profile: answered } = applyAnswer(
      { ...ctxFor(), profile: first.profile },
      { key: 'transport.cabin_class', value: 'economy', skipped: false },
    );
    expect(answered.skippedKeys).not.toContain('transport.cabin_class');
    expect(answered.answeredKeys).toContain('transport.cabin_class');
  });

  it('tells the client the same limits the server enforces', () => {
    const ranking = askEverythingQuestions(ctxFor()).find((q) => q.key === 'priorities.ranking');
    expect(ranking).toMatchObject({ minSelections: 1, maxSelections: 4 });
  });
});

type Ctx = ReturnType<typeof ctxFor>;

/** A valid answer for any question, used to walk past required ones. */
function validAnswerFor(q: Question): unknown {
  switch (q.kind) {
    case 'money':
      return { amount: 5_000_000, currency: q.currency };
    case 'single_choice':
      return q.options[0]!.value;
    case 'multi_choice':
    case 'ranking':
      return q.options.slice(0, Math.max(1, q.minSelections ?? 0)).map((o) => o.value);
    case 'number':
      return q.min ?? 0;
    case 'boolean':
      return true;
    default:
      return 'near the centre';
  }
}

/**
 * Walks the whole interview, skipping what may be skipped and answering what
 * planning requires, and returns every question it was asked.
 */
function askEverythingQuestions(ctx: Ctx): Question[] {
  const asked: Question[] = [];
  let current = ctx;
  for (let i = 0; i < 25; i += 1) {
    const q = nextQuestion(current);
    if (!q) break;
    asked.push(q);
    const answer = q.required
      ? { key: q.key, value: validAnswerFor(q) as never, skipped: false }
      : { key: q.key, value: null, skipped: true };
    current = { ...current, profile: applyAnswer(current, answer).profile };
  }
  return asked;
}

function askEverything(ctx: Ctx): string[] {
  return askEverythingQuestions(ctx).map((q) => q.key);
}

void hyderabad;
void bengaluru;

describe('how firm the budget is', () => {
  const afterBudget = () => {
    const ctx = ctxFor();
    return {
      ...ctx,
      profile: applyAnswer(ctx, {
        key: 'budget.total',
        value: { amount: 5_000_000, currency: 'INR' },
        skipped: false,
      }).profile,
    };
  };

  it('is asked right after the budget, and only then', () => {
    expect(nextQuestion(ctxFor())?.key).toBe('budget.total');
    expect(nextQuestion(afterBudget())?.key).toBe('budget.firm');
  });

  it('is optional, so skipping it leaves the budget a guide', () => {
    const q = nextQuestion(afterBudget())!;
    expect(q.required).toBe(false);
    const { profile: skipped } = applyAnswer(afterBudget(), { key: 'budget.firm', value: null, skipped: true });
    expect(skipped.skippedKeys).toContain('budget.firm');
    expect(questionnaireState({ ...afterBudget(), profile: skipped }).canPlan).toBe(false);
  });

  it('only accepts the two choices offered', () => {
    const ctx = afterBudget();
    expect(() => applyAnswer(ctx, { key: 'budget.firm', value: 'firm', skipped: false })).not.toThrow();
    expect(() => applyAnswer(ctx, { key: 'budget.firm', value: 'guide', skipped: false })).not.toThrow();
    expect(() => applyAnswer(ctx, { key: 'budget.firm', value: 'strict', skipped: false })).toThrow(
      /choose one of the options/,
    );
  });
});
