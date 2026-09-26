/**
 * Checking a written explanation against the facts it was given.
 *
 * The rule is narrow on purpose: the explanation may say things in its own
 * words, but it may not contain a number the facts do not contain, a link, or a
 * claim about something having been booked, paid for or guaranteed. Those are
 * the three ways prose goes from explaining a plan to making one up. A text
 * that fails is not repaired; it is replaced by the template's.
 */

/** Phrases that assert an action happened or a promise was made. */
const CLAIM = /\b(?:has|have|had|is|are|was|were|been|now|already)\s+(?:been\s+)?(?:booked|confirmed|reserved|guaranteed|paid|charged|ticketed)\b|\b(?:i|we)\s+(?:have\s+)?(?:booked|reserved|confirmed|paid|charged)\b|\bguarantee[sd]?\b|\byour (?:booking|reservation|ticket)s?\b/i;

/** "Nothing has been booked" is a true statement, and is allowed. */
const NEGATED = /\b(?:nothing|not|no|never|isn'?t|hasn'?t|haven'?t|wasn'?t)\b[^.!?]{0,30}?\b(?:booked|charged|confirmed|reserved|paid|ticketed)\b/gi;

export function figuresIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Text that comes from a provider (a hotel's name, a carrier, a note) and
 * asserts something this planner cannot stand behind: a link, or a claim that a
 * booking exists. Such text is not passed on as fact, whoever is asked to
 * repeat it.
 */
export function assertsTooMuch(text: string): boolean {
  if (/https?:\/\/|www\./i.test(text)) return true;
  return CLAIM.test(text.replace(NEGATED, ' '));
}

export type NarrativeCheck = { ok: true } | { ok: false; reason: string };

export function checkNarrative(text: string, allowed: ReadonlySet<number>): NarrativeCheck {
  if (/https?:\/\/|www\./i.test(text)) return { ok: false, reason: 'it contains a link' };
  const scrubbed = text.replace(NEGATED, ' ');
  if (CLAIM.test(scrubbed)) return { ok: false, reason: 'it claims something was booked, paid for or guaranteed' };
  // A figure spelled out in words is still a figure.
  if (/\b(?:hundred|thousand|lakhs?|crores?|million|billion)\b/i.test(text)) {
    return { ok: false, reason: 'it states a figure in words' };
  }
  for (const n of figuresIn(text)) {
    if (!allowed.has(n)) return { ok: false, reason: `it states a figure (${n}) that is not in the plan` };
  }
  return { ok: true };
}
