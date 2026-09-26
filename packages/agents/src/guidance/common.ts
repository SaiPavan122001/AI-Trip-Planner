import type { StatedHard, RequirementsState, SoftKind, StatedSoft } from '@trip/shared';
import { evidenceMentions } from '../requirements/vocabulary.js';

/**
 * What the traveller has actually said, in the form the guidance agents are
 * grounded in. A guidance agent may interpret and combine what was said; it
 * may not introduce a preference the traveller never expressed. So every value
 * it proposes must be one the traveller stated, or one their own words
 * mention.
 */
export interface StatedContext {
  soft: StatedSoft[];
  hard: StatedHard[];
  /** The traveller's quoted words, joined. */
  text: string;
}

export const statedFrom = (requirements: RequirementsState | null): StatedContext => ({
  soft: requirements?.soft ?? [],
  hard: requirements?.hard ?? [],
  text: [...(requirements?.hard ?? []), ...(requirements?.soft ?? [])].map((r) => r.evidence).join(' . '),
});

/** Is this value one the traveller stated, or one their words mention? */
export function grounded(kind: SoftKind, value: string, stated: StatedContext): boolean {
  if (stated.soft.some((s) => s.kind === kind && s.value === value)) return true;
  return evidenceMentions(kind, value, stated.text);
}

/**
 * Explanations a model offers for its own choices. They are kept in the trace
 * for whoever debugs a plan, never shown to a traveller as fact, and refuse
 * anything that looks like a figure: a reason that says "saves ₹2,000" is the
 * model inventing a price.
 */
export function cleanReasons(reasons: readonly string[], rejected: string[]): string[] {
  const out: string[] = [];
  for (const raw of reasons.slice(0, 6)) {
    // eslint-disable-next-line no-control-regex
    const text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length === 0) continue;
    if (text.length > 200 || /[₹$€£]|\d|https?:\/\//i.test(text)) {
      rejected.push('a reason contained a figure, a link or was too long');
      continue;
    }
    out.push(text);
  }
  return out;
}
