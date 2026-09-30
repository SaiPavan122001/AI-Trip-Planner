import { contentTerms } from './embedder.js';
import { CERTAINTY_WORDS, hasNegation, numbersIn, urlsIn } from './facts.js';

/**
 * Deciding, in code, whether a sentence a model wrote is backed by the text it
 * says it came from.
 *
 * A claim is accepted only if all of these hold against the chunks it cites:
 *
 *  1. every link in it is a link in those sources (no invented URLs);
 *  2. every figure in it (an amount, a percentage, a count with a unit, a date)
 *     is a figure in those sources: an invented price cannot pass;
 *  3. most of its content words appear in those sources (`MIN_SUPPORT`);
 *  4. the source sentence it most resembles does not say the opposite ("not
 *     refundable" turned into "refundable");
 *  5. it does not promise more than the source ("guaranteed", "always",
 *     "no exceptions") unless the source says so too.
 *
 * This is a lexical check. It is strong against the failures that hurt here
 * (an invented figure, an invented source, a flipped "not", an added promise)
 * and weak against a sentence that reuses a source's words to mean something
 * else. It also cannot tell a document that is *wrong* from one that is right.
 * docs/knowledge.md, "Groundedness", states the limits and the measured
 * accuracy on the labelled set.
 */

export const VERIFIER_VERSION = 'lexical/1';
export const MIN_SUPPORT = 0.65;
const PARTIAL_FLOOR = 0.4;

export type ClaimVerdict = 'supported' | 'unsupported' | 'contradicted';
export type ClaimProblem = 'invented_url' | 'figure_not_in_source' | 'not_in_source' | 'partial_support' | 'negation_flipped' | 'overstated' | 'empty' | 'off_topic';

export interface ClaimCheck {
  verdict: ClaimVerdict;
  /** Share of the claim's content words found in the sources. */
  support: number;
  problems: ClaimProblem[];
}

export interface SourceText {
  text: string;
  title: string;
  heading: string;
  url: string | null;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9₹"'([])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function overlap(claimTerms: readonly string[], text: string): number {
  if (claimTerms.length === 0) return 0;
  const have = new Set(contentTerms(text));
  let found = 0;
  for (const t of claimTerms) if (have.has(t)) found++;
  return found / claimTerms.length;
}

export function verifyClaim(claim: string, sources: readonly SourceText[]): ClaimCheck {
  const claimTerms = [...new Set(contentTerms(claim))];
  if (claim.trim().length === 0 || claimTerms.length === 0 || sources.length === 0) return { verdict: 'unsupported', support: 0, problems: ['empty'] };

  const body = sources.map((s) => s.text).join('\n');
  const context = sources.map((s) => `${s.title} ${s.heading} ${s.text}`).join('\n');
  const support = overlap(claimTerms, context);
  const problems: ClaimProblem[] = [];

  const known = new Set(sources.flatMap((s) => [...urlsIn(s.text), ...(s.url ? [s.url] : [])]).map((u) => u.replace(/[.,;]+$/, '').toLowerCase()));
  for (const url of urlsIn(claim)) if (!known.has(url.replace(/[.,;]+$/, '').toLowerCase())) problems.push('invented_url');

  const sourceFigures = numbersIn(context);
  const missing = [...numbersIn(claim)].filter((f) => !sourceFigures.has(f));
  if (missing.length > 0) problems.push('figure_not_in_source');

  if (support < MIN_SUPPORT) problems.push(support >= PARTIAL_FLOOR ? 'partial_support' : 'not_in_source');

  // The source sentence that most resembles the claim, and whether it says the opposite.
  let best = { text: '', score: 0 };
  for (const s of sentences(body)) {
    const score = overlap(claimTerms, s);
    if (score > best.score) best = { text: s, score };
  }
  if (best.score >= 0.5 && hasNegation(claim) !== hasNegation(best.text)) problems.push('negation_flipped');

  if (CERTAINTY_WORDS.test(claim) && !CERTAINTY_WORDS.test(context)) problems.push('overstated');

  if (problems.length === 0) return { verdict: 'supported', support, problems };
  // A claim that reads like the source but with a figure or a "not" changed says the opposite of it; one that is
  // merely unsupported says something the source does not.
  const contradicted = problems.includes('negation_flipped') || (problems.includes('figure_not_in_source') && support >= MIN_SUPPORT - 0.15);
  return { verdict: contradicted ? 'contradicted' : 'unsupported', support, problems };
}
