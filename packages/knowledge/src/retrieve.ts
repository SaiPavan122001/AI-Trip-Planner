import { metrics, withSpan } from '@trip/telemetry';
import { contentTerms, type Embedder } from './embedder.js';
import { hasNegation, numbersIn } from './facts.js';
import { scanText } from './scan.js';
import type { KnowledgeStore } from './store.js';
import { DEFAULT_MIN_AUTHORITY, type IndexedChunk } from './types.js';

/**
 * Finding what is written down about a question, and knowing when nothing is.
 *
 * The order is fixed and every step is deterministic:
 *
 *   embed the question  ->  exact search in one namespace and one embedding
 *   space, with the metadata filters (authority, destination, topic) applied
 *   inside the search  ->  drop chunks that trip the injection screen again
 *   ->  drop chunks from documents past their review date  ->  optional lexical
 *   re-rank  ->  keep the top k that clear the relevance threshold  ->  the
 *   confidence gate  ->  note where two documents on one topic disagree.
 *
 * "Insufficient" is a normal, first-class result, not an error: it is what a
 * question the index cannot answer gets, and it is what stops the model from
 * being asked to improvise.
 */

export interface RetrievalParams {
  /** How many chunks may be handed on. */
  k: number;
  /** Cosine similarity the best chunk must reach (before any re-rank). */
  minScore: number;
  /** Weighted share of the question's content words that the kept chunks (with their titles and headings) must contain; see `termWeights`. */
  minCoverage: number;
  minAuthority: number;
  /** `lexical` blends the similarity with the question-word coverage of each chunk; `none` keeps the similarity order. */
  rerank: 'none' | 'lexical';
  /** A question with fewer content words than this is too vague to search for. */
  minQueryTerms: number;
  /** At most this many chunks from one document, so a question that spans documents is not filled by one of them. */
  maxPerDoc: number;
  /** How many candidates to fetch per chunk kept, so filtering and re-ranking have something to choose from. */
  candidateFactor: number;
  /** Screen each retrieved chunk for instruction-like text again (see scan.ts). Only evaluation turns this off, to measure the layers behind it. */
  screen: boolean;
  /** Serve chunks from documents past `reviewBy`. Off: they are counted and reported, not used. */
  includeStale: boolean;
}

export const DEFAULT_RETRIEVAL: RetrievalParams = {
  k: 4,
  minScore: 0.28,
  minCoverage: 0.5,
  minQueryTerms: 2,
  maxPerDoc: 2,
  minAuthority: DEFAULT_MIN_AUTHORITY,
  rerank: 'lexical',
  candidateFactor: 4,
  screen: true,
  includeStale: false,
};

export interface RetrievalRequest {
  namespace: string;
  query: string;
  destination?: string | undefined;
  topics?: readonly string[] | undefined;
  /** "Today", as YYYY-MM-DD; passed in so a run is reproducible. */
  asOf: string;
  params?: Partial<RetrievalParams>;
  signal?: AbortSignal | undefined;
}

export interface RetrievedChunk {
  chunk: IndexedChunk;
  /** Cosine similarity, as the store returned it. */
  score: number;
  /** Weighted share of the question's content words this chunk contains. */
  coverage: number;
  /** The number the order is by (the score, or the blend when re-ranking). */
  rank: number;
}

export interface Conflict {
  topic: string;
  /** The heading (last part of the path, lower case) the disagreeing text sits under. */
  heading: string;
  kind: 'figures' | 'polarity';
  sides: Array<{ docId: string; title: string; chunkId: string; authority: number; effectiveDate: string; version: number }>;
}

export type InsufficientReason = 'empty_query' | 'no_index' | 'below_threshold' | 'low_coverage' | 'only_outdated';

export interface RetrievalResult {
  outcome: 'ok' | 'insufficient';
  reason: InsufficientReason | null;
  hits: RetrievedChunk[];
  conflicts: Conflict[];
  excluded: { flagged: number; outdated: number };
  /** Documents that matched but are past their review date. */
  outdatedDocs: Array<{ docId: string; title: string; reviewBy: string }>;
  space: string;
  /** Embedding calls made for this question: 1, or 0 when the question was too vague to search. */
  embedCalls: number;
  params: RetrievalParams;
  /** How much each of the question's words counts; the answer step uses the same weights. */
  weights: Record<string, number>;
  timings: { embedMs: number; searchMs: number };
}

export interface RetrievalDeps {
  store: KnowledgeStore;
  embedder: Embedder;
}

/**
 * How much each word of the question counts. A word that is in most of the
 * candidates ("railway", when every candidate is about the railway) says little
 * about what is being asked; a word that is in none of them ("dining", "taxi")
 * is exactly what the answer would have to supply. So a term's weight falls as
 * the share of candidates containing it rises: ln(1 + (N + 1) / (df + 1)).
 * Computed from the candidate pool of this one search, so it needs nothing
 * stored and adapts to whatever the index holds.
 */
export function termWeights(queryTerms: readonly string[], candidateTexts: readonly string[]): Map<string, number> {
  const n = candidateTexts.length;
  const sets = candidateTexts.map((t) => new Set(contentTerms(t)));
  const out = new Map<string, number>();
  for (const term of queryTerms) {
    const df = sets.reduce((k, s) => (s.has(term) ? k + 1 : k), 0);
    out.set(term, Math.log(1 + (n + 1) / (df + 1)));
  }
  return out;
}

export function weightedCoverage(weights: ReadonlyMap<string, number>, text: string): number {
  let total = 0;
  let found = 0;
  const have = new Set(contentTerms(text));
  for (const [term, w] of weights) {
    total += w;
    if (have.has(term)) found += w;
  }
  return total === 0 ? 0 : found / total;
}

export async function retrieve(deps: RetrievalDeps, request: RetrievalRequest): Promise<RetrievalResult> {
  const params: RetrievalParams = { ...DEFAULT_RETRIEVAL, ...request.params };
  const space = deps.embedder.space;
  const empty = (reason: InsufficientReason, extra: Partial<RetrievalResult> = {}): RetrievalResult => ({
    outcome: 'insufficient',
    reason,
    hits: [],
    conflicts: [],
    excluded: { flagged: 0, outdated: 0 },
    outdatedDocs: [],
    space,
    embedCalls: 0,
    params,
    weights: {},
    timings: { embedMs: 0, searchMs: 0 },
    ...extra,
  });

  const queryTerms = [...new Set(contentTerms(request.query))];
  if (queryTerms.length < Math.max(1, params.minQueryTerms)) return empty('empty_query');

  return withSpan('knowledge.retrieve', { 'knowledge.namespace': request.namespace, 'knowledge.k': params.k }, async (span) => {
    const t0 = performance.now();
    const [vector] = await deps.embedder.embed([request.query], request.signal);
    const embedMs = performance.now() - t0;
    metrics.knowledgeDuration.observe({ stage: 'embed' }, embedMs / 1000);
    if (!vector || vector.length !== deps.embedder.dimension) throw new Error('the embedder returned a vector that does not match its declared dimension');

    const t1 = performance.now();
    const candidates = await deps.store.search({
      namespace: request.namespace,
      space,
      vector,
      k: Math.max(params.k, 1) * Math.max(params.candidateFactor, 1),
      filters: {
        minAuthority: params.minAuthority,
        ...(request.destination ? { destination: request.destination } : {}),
        ...(request.topics ? { topics: request.topics } : {}),
      },
    });
    const searchMs = performance.now() - t1;
    metrics.knowledgeDuration.observe({ stage: 'retrieve' }, searchMs / 1000);
    const timings = { embedMs, searchMs };
    span.setAttribute('knowledge.candidates', candidates.length);

    if (candidates.length === 0) {
      const anyIndexed = (await deps.store.spaces(request.namespace)).length > 0;
      return empty(anyIndexed ? 'below_threshold' : 'no_index', { timings, embedCalls: 1 });
    }

    const weights = termWeights(queryTerms, candidates.map(({ chunk }) => `${chunk.title} ${chunk.heading} ${chunk.text}`));
    const weightsOut = Object.fromEntries(weights);
    let flagged = 0;
    let outdated = 0;
    const outdatedDocs = new Map<string, { docId: string; title: string; reviewBy: string }>();
    const usable: RetrievedChunk[] = [];
    let outdatedRelevant = false;
    for (const { chunk, score } of candidates) {
      // The screen again, on what is about to be shown to a model: an index altered behind ingestion is still screened.
      if (params.screen && scanText([chunk.text, chunk.heading, chunk.title, chunk.reference, chunk.url ?? ''].join('\n')).flagged) {
        flagged++;
        continue;
      }
      if (chunk.reviewBy !== null && chunk.reviewBy < request.asOf && !params.includeStale) {
        outdated++;
        outdatedDocs.set(chunk.docId, { docId: chunk.docId, title: chunk.title, reviewBy: chunk.reviewBy });
        if (score >= params.minScore) outdatedRelevant = true;
        continue;
      }
      const coverage = weightedCoverage(weights, `${chunk.title} ${chunk.heading} ${chunk.text}`);
      const rank = params.rerank === 'lexical' ? Math.round((0.7 * score + 0.3 * coverage) * 1e6) / 1e6 : score;
      usable.push({ chunk, score, coverage, rank });
    }
    usable.sort((a, b) => b.rank - a.rank || (a.chunk.id < b.chunk.id ? -1 : a.chunk.id > b.chunk.id ? 1 : 0));

    const base = { excluded: { flagged, outdated }, outdatedDocs: [...outdatedDocs.values()], weights: weightsOut, timings, embedCalls: 1 };
    const perDoc = new Map<string, number>();
    const hits: RetrievedChunk[] = [];
    for (const h of usable) {
      if (h.score < params.minScore || hits.length >= params.k) continue;
      const n = perDoc.get(h.chunk.docId) ?? 0;
      if (n >= Math.max(1, params.maxPerDoc)) continue;
      perDoc.set(h.chunk.docId, n + 1);
      hits.push(h);
    }
    if (hits.length === 0) return empty(outdatedRelevant ? 'only_outdated' : 'below_threshold', base);

    const union = hits.map((h) => `${h.chunk.title} ${h.chunk.heading} ${h.chunk.text}`).join('\n');
    if (weightedCoverage(weights, union) < params.minCoverage) return empty('low_coverage', base);

    span.setAttribute('knowledge.hits', hits.length);
    // A source that disagrees may sit just below the cut. Chunks on the same topic and under the same heading as a kept
    // one, from another document, are checked too, and are added to the hits only if they do disagree: the answer must
    // never quietly pick one side of a disagreement because the other side ranked fifth.
    const kept = new Set(hits.map((h) => h.chunk.id));
    const siblings: RetrievedChunk[] = [];
    for (const u of usable) {
      if (kept.has(u.chunk.id) || u.chunk.topic === null || u.score < params.minScore / 2) continue;
      const beside = hits.some((h) => h.chunk.topic === u.chunk.topic && h.chunk.docId !== u.chunk.docId && leafHeading(h.chunk.heading) === leafHeading(u.chunk.heading));
      if (beside && !siblings.some((x) => x.chunk.docId === u.chunk.docId && leafHeading(x.chunk.heading) === leafHeading(u.chunk.heading))) siblings.push(u);
    }
    const conflicts = findConflicts([...hits, ...siblings]);
    const inConflict = new Set(conflicts.flatMap((c) => c.sides.map((x) => x.chunkId)));
    for (const sibling of siblings) if (inConflict.has(sibling.chunk.id)) hits.push(sibling);
    return { outcome: 'ok', reason: null, hits, conflicts, space, params, ...base };
  });
}

/**
 * Two documents about one topic, under the same heading, whose retrieved text disagrees. Two ways are
 * recognised, both lexical: the figures in them differ (one says 10%, the other
 * 20%, and neither set of figures contains the other), or, when neither has any
 * figures, one says "not" and the other does not. A disagreement is reported,
 * not resolved: which side is right is for the traveller (and the operator who
 * fed the index) to decide, and the answer shows both.
 */
function leafHeading(heading: string): string {
  return (heading.split('>').pop() ?? '').trim().toLowerCase();
}

export function findConflicts(hits: readonly RetrievedChunk[]): Conflict[] {
  const byTopic = new Map<string, Map<string, RetrievedChunk[]>>();
  for (const h of hits) {
    if (h.chunk.topic === null) continue;
    // Only text under the same heading is compared: two documents on one topic that cover different parts of it (one gives
    // the fee, the other the opening hours) do not disagree.
    const key = `${h.chunk.topic}::${leafHeading(h.chunk.heading)}`;
    const docs = byTopic.get(key) ?? new Map<string, RetrievedChunk[]>();
    docs.set(h.chunk.docId, [...(docs.get(h.chunk.docId) ?? []), h]);
    byTopic.set(key, docs);
  }
  const out: Conflict[] = [];
  for (const [key, docs] of [...byTopic].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const topic = key.slice(0, key.indexOf('::'));
    const heading = key.slice(key.indexOf('::') + 2);
    if (docs.size < 2) continue;
    const entries = [...docs].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([docId, list]) => {
      const text = list.map((h) => h.chunk.text).join('\n');
      return { docId, best: list[0]!, figures: numbersIn(text), negated: hasNegation(text) };
    });
    let kind: Conflict['kind'] | null = null;
    outer: for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i]!;
        const b = entries[j]!;
        if (a.figures.size > 0 && b.figures.size > 0) {
          const aInB = [...a.figures].every((f) => b.figures.has(f));
          const bInA = [...b.figures].every((f) => a.figures.has(f));
          if (!aInB && !bInA) {
            kind = 'figures';
            break outer;
          }
        } else if (a.figures.size === 0 && b.figures.size === 0 && a.negated !== b.negated) {
          kind = 'polarity';
          break outer;
        }
      }
    }
    if (kind) {
      out.push({
        topic,
        heading,
        kind,
        sides: entries.map((e) => ({
          docId: e.docId,
          title: e.best.chunk.title,
          chunkId: e.best.chunk.id,
          authority: e.best.chunk.authority,
          effectiveDate: e.best.chunk.effectiveDate,
          version: e.best.chunk.version,
        })),
      });
    }
  }
  return out;
}
