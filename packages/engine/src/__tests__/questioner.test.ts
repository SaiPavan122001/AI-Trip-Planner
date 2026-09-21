import { describe, expect, it } from 'vitest';
import { classifyJourney } from '../classify.js';
import { applyAnswer, nextQuestion, questionnaireState } from '../questioner.js';
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
    const answered = applyAnswer(ctx.profile, {
      key: 'style.travel_style',
      value: 'premium',
      skipped: false,
    });
    const keys: string[] = [];
    let current = { ...ctx, profile: answered };
    for (let i = 0; i < 12; i += 1) {
      const q = nextQuestion(current);
      if (!q) break;
      keys.push(q.key);
      current = {
        ...current,
        profile: applyAnswer(current.profile, { key: q.key, value: null, skipped: true }),
      };
    }
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
    const skipped = applyAnswer(profile(), {
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
      applyAnswer(profile(), { key: 'not.a.question', value: 'x', skipped: false }),
    ).toThrow(/Unknown question key/);
  });

  it('turns a mode selection into exclusions for everything unselected', () => {
    const updated = applyAnswer(profile(), {
      key: 'transport.mode_openness',
      value: ['flight', 'train'],
      skipped: false,
    });
    expect(updated.transport.excludedModes).toContain('bus');
    expect(updated.transport.excludedModes).not.toContain('flight');
  });

  it('records "overnight is fine" as not avoiding overnight travel', () => {
    const yes = applyAnswer(profile(), {
      key: 'transport.overnight',
      value: true,
      skipped: false,
    });
    const no = applyAnswer(profile(), {
      key: 'transport.overnight',
      value: false,
      skipped: false,
    });
    expect(yes.transport.avoidOvernightTravel).toBe(false);
    expect(no.transport.avoidOvernightTravel).toBe(true);
  });
});

/** Walks the whole interview by skipping, collecting every key it offers. */
function askEverything(ctx: ReturnType<typeof ctxFor>): string[] {
  const keys: string[] = [];
  let current = ctx;
  for (let i = 0; i < 25; i += 1) {
    const q = nextQuestion(current);
    if (!q) break;
    keys.push(q.key);
    current = {
      ...current,
      profile: applyAnswer(current.profile, { key: q.key, value: null, skipped: true }),
    };
  }
  return keys;
}

void hyderabad;
void bengaluru;
