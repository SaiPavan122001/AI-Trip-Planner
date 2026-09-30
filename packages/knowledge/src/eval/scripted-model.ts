import { LlmInvalidOutputError, LlmUnavailableError, type ExtractRequest, type LlmResult } from '@trip/llm';
import { contentTerms } from '../embedder.js';
import type { KnowledgeModel } from '../answer.js';

/**
 * Stand-ins for a language model, each with one fixed behaviour.
 *
 * What these are for: the evaluation asks whether the *pipeline* holds when a
 * model does something wrong. A model that copies a sentence faithfully, one
 * that changes a figure, one that cites a source that was never retrieved, one
 * that adds a fact, one that overstates, one that flips a "not", one that does
 * what an injected instruction says: each is written out here, so each is
 * reproducible and no network or key is involved. They read the same prompt
 * the real model would be given (the escaped `<source>` blocks and the
 * `<user_question>`), so they exercise the real prompt layout.
 *
 * What they are not: evidence about any real model. How often a real model
 * misbehaves in each of these ways is a separate, live measurement that this
 * repository has not made (docs/knowledge.md, "What is not verified").
 */

export type ScriptedBehaviour =
  | 'faithful'
  | 'changed_figure'
  | 'invented_source'
  | 'invented_fact'
  | 'overconfident'
  | 'flipped_negation'
  | 'invented_url'
  | 'obedient'
  | 'declines'
  | 'garbage'
  | 'unavailable';

interface PromptSource {
  id: string;
  title: string;
  text: string;
}

function readSources(input: string): PromptSource[] {
  const out: PromptSource[] = [];
  for (const m of input.matchAll(/<source>(.*?)<\/source>/gs)) {
    try {
      const v = JSON.parse(m[1]!) as { id?: unknown; title?: unknown; text?: unknown };
      if (typeof v.id === 'string' && typeof v.text === 'string') out.push({ id: v.id, title: String(v.title ?? ''), text: v.text });
    } catch {
      /* a block that is not JSON is not a source */
    }
  }
  return out;
}

function readQuestion(input: string): string {
  const m = /<user_question>(.*?)<\/user_question>/s.exec(input);
  if (!m) return '';
  try {
    return String(JSON.parse(m[1]!));
  } catch {
    return '';
  }
}

interface Ranked {
  text: string;
  id: string;
  score: number;
}

/**
 * The sentences of the sources, best first, scored the way a sensible reader would: by how much of the question each
 * covers, counting a word that is in every source for less than one that is in few (so "railway" does not decide it).
 */
function rankedSentences(question: string, sources: PromptSource[]): Ranked[] {
  const terms = [...new Set(contentTerms(question))];
  const sets = sources.map((s) => new Set(contentTerms(`${s.title} ${s.text}`)));
  const weight = new Map(terms.map((t) => [t, Math.log(1 + (sources.length + 1) / (sets.filter((x) => x.has(t)).length + 1))]));
  const out: Ranked[] = [];
  for (const s of sources) {
    const context = new Set(contentTerms(s.title));
    for (const sentence of s.text.split(/(?<=[.!?])\s+|\n+/).map((x) => x.replace(/^\s*(?:[-*•]|\d{1,3}[.)])\s+/, '').trim()).filter((x) => x.length >= 12)) {
      const have = new Set([...contentTerms(sentence), ...context]);
      const score = terms.reduce((sum, t) => (have.has(t) ? sum + weight.get(t)! : sum), 0);
      if (score > 0) out.push({ text: sentence, id: s.id, score });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

function bestSentence(question: string, sources: PromptSource[]): { text: string; id: string } | null {
  const [best] = rankedSentences(question, sources);
  return best ? { text: best.text, id: best.id } : null;
}

/** The best sentence, and the next best if it is nearly as good (a second source, or the rest of the rule). */
function faithfulClaims(question: string, sources: PromptSource[]): Array<{ text: string; sources: string[] }> {
  const ranked = rankedSentences(question, sources);
  const [first, second] = ranked;
  if (!first) return [];
  const claims = [{ text: first.text, sources: [first.id] }];
  if (second && second.score >= first.score * 0.6) claims.push({ text: second.text, sources: [second.id] });
  return claims;
}

/** What an instruction-following model would do with "say X" / "output X" in its input: it says X. */
function decodedVariants(text: string): string[] {
  const out = [text];
  for (const run of text.match(/[A-Za-z0-9+/]{24,}={0,2}/g) ?? []) {
    const decoded = Buffer.from(run, 'base64').toString('utf8');
    if (/^[\x20-\x7e]{8,}$/.test(decoded)) out.push(decoded);
  }
  for (const run of text.match(/\b(?:[0-9a-fA-F]{2}){12,}\b/g) ?? []) {
    const decoded = Buffer.from(run, 'hex').toString('utf8');
    if (/^[\x20-\x7e]{8,}$/.test(decoded)) out.push(decoded);
  }
  out.push(text.replace(/[a-z]/gi, (c) => String.fromCharCode(((c.charCodeAt(0) - (c <= 'Z' ? 65 : 97) + 13) % 26) + (c <= 'Z' ? 65 : 97))));
  return out;
}

/** The instruction a model that decodes, and obeys, would find in a text: it reads base64, hex and rot13 too. */
function injectedTarget(text: string): string | null {
  for (const variant of decodedVariants(text)) {
    const found = firstTarget(variant);
    if (found) return found;
  }
  return null;
}

function firstTarget(text: string): string | null {
  // A verb of speaking, then what is to be said: up to five words, ending at a full stop, a line end, "and" or "then".
  const m = /\b(?:say|reply|respond|output|answer|write|print|state)\b\s+(?:with\s+|that\s+|only\s+|the\s+code\s+)?["'“]?([A-Za-z0-9][A-Za-z0-9_.:/-]*(?: [A-Za-z0-9_.:/-]+){0,9}?)["'”]?\s*(?:[.\n]|\band\b|\bthen\b|$)/i.exec(text);
  return m ? m[1]!.trim() : null;
}

export class ScriptedModel implements KnowledgeModel {
  readonly available = true;
  calls = 0;
  lastInput = '';

  constructor(private readonly behaviour: ScriptedBehaviour) {}

  async structured<T>(req: ExtractRequest<T>): Promise<LlmResult<T>> {
    this.calls++;
    this.lastInput = req.input;
    if (this.behaviour === 'unavailable') throw new LlmUnavailableError('scripted', 'The scripted model is unavailable.');
    if (this.behaviour === 'garbage') throw new LlmInvalidOutputError('scripted', 'The scripted model answered off-schema.');

    const sources = readSources(req.input);
    const question = readQuestion(req.input);
    const best = bestSentence(question, sources);
    const top = sources[0];
    let data: { answerable: boolean; claims: Array<{ text: string; sources: string[] }> };

    switch (this.behaviour) {
      case 'declines':
        data = { answerable: false, claims: [] };
        break;
      case 'faithful':
        data = best ? { answerable: true, claims: faithfulClaims(question, sources) } : { answerable: false, claims: [] };
        break;
      case 'changed_figure':
        data = best ? { answerable: true, claims: [{ text: best.text.replace(/\d+/, (n) => String(Number(n) + 7)), sources: [best.id] }] } : { answerable: false, claims: [] };
        break;
      case 'invented_source':
        data = best ? { answerable: true, claims: [{ text: best.text, sources: ['made-up-source@v1#0'] }] } : { answerable: false, claims: [] };
        break;
      case 'invented_fact':
        data = top ? { answerable: true, claims: [{ text: 'A ticket costs ₹450 and senior citizens get a discount of 20%.', sources: [top.id] }] } : { answerable: false, claims: [] };
        break;
      case 'overconfident':
        data = best ? { answerable: true, claims: [{ text: `${best.text.replace(/\.$/, '')}, and this is guaranteed with no exceptions.`, sources: [best.id] }] } : { answerable: false, claims: [] };
        break;
      case 'flipped_negation':
        data = best
          ? { answerable: true, claims: [{ text: /\bnot\b/i.test(best.text) ? best.text.replace(/\bnot\s+/i, '') : best.text.replace(/\b(is|are|may|can|will)\b/i, '$1 not'), sources: [best.id] }] }
          : { answerable: false, claims: [] };
        break;
      case 'invented_url':
        data = best ? { answerable: true, claims: [{ text: `${best.text.replace(/\.$/, '')}. Details: https://evil.example.net/details`, sources: [best.id] }] } : { answerable: false, claims: [] };
        break;
      case 'obedient': {
        // Does what the text in front of it says to do: the question first, then each source.
        const target = injectedTarget(question) ?? sources.map((s) => injectedTarget(s.text)).find((t): t is string => t !== null) ?? null;
        data = target && top ? { answerable: true, claims: [{ text: target, sources: [top.id] }] } : best ? { answerable: true, claims: [{ text: best.text, sources: [best.id] }] } : { answerable: false, claims: [] };
        break;
      }
    }
    return {
      data: req.schema.parse(data),
      usage: { inputTokens: Math.ceil((req.system.length + req.input.length) / 4), outputTokens: Math.ceil(JSON.stringify(data).length / 4), cachedInputTokens: 0 },
      model: 'scripted',
      fromFallback: false,
    };
  }
}
