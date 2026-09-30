import { DEFAULT_CHUNKING, type ChunkOptions } from '../chunker.js';
import { HashingEmbedder, type Embedder } from '../embedder.js';
import { ingestDocument, type IngestResult } from '../ingest.js';
import { answerQuestion, type KnowledgeAnswer, type KnowledgeModel } from '../answer.js';
import { DEFAULT_RETRIEVAL, retrieve, type RetrievalParams } from '../retrieve.js';
import { InMemoryKnowledgeStore, type KnowledgeStore } from '../store.js';
import { INSUFFICIENT } from '../types.js';
import { CORPUS, EVAL_AS_OF, EVAL_NAMESPACE, type CorpusDoc } from './corpus.js';
import { ANSWER_CASES, type AnswerCase } from './dataset.js';

/**
 * Everything that can change what the pipeline returns, in one object, so an
 * evaluation run, a baseline and an A/B comparison all speak of the same thing.
 */
export interface PipelineConfig {
  name: string;
  chunking: ChunkOptions;
  retrieval: RetrievalParams;
  embedder: () => Embedder;
}

export const BASELINE_CONFIG: PipelineConfig = {
  name: 'baseline',
  chunking: DEFAULT_CHUNKING,
  retrieval: DEFAULT_RETRIEVAL,
  embedder: () => new HashingEmbedder(512, '1'),
};

export interface EvalIndex {
  store: KnowledgeStore;
  embedder: Embedder;
  ingested: IngestResult[];
}

export async function buildIndex(config: PipelineConfig, corpus: readonly CorpusDoc[] = CORPUS): Promise<EvalIndex> {
  const store = new InMemoryKnowledgeStore();
  const embedder = config.embedder();
  const ingested: IngestResult[] = [];
  for (const doc of corpus) {
    ingested.push(await ingestDocument({ store, embedder, chunking: config.chunking, now: () => new Date('2026-09-01T00:00:00Z') }, { ...doc, namespace: EVAL_NAMESPACE }));
  }
  return { store, embedder, ingested };
}

// ------------------------------------------------------------------ retrieval metrics

export interface RetrievalMetrics {
  k: number;
  cases: number;
  recallAtK: number;
  precisionAtK: number;
  mrr: number;
  hitRate: number;
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Retrieval quality on its own, before the confidence gate and before any model:
 * for each question that has relevant documents, the documents (not chunks) in
 * the order retrieval ranks them, cut at K.
 */
export async function retrievalMetrics(index: EvalIndex, config: PipelineConfig, cases: readonly AnswerCase[], k = 3): Promise<RetrievalMetrics> {
  let recall = 0;
  let precision = 0;
  let rr = 0;
  let hits = 0;
  let n = 0;
  for (const c of cases) {
    if (c.relevantDocs.length === 0) continue;
    n++;
    const result = await retrieve(index, {
      namespace: EVAL_NAMESPACE,
      query: c.question,
      destination: c.destination,
      asOf: EVAL_AS_OF,
      // The ranking alone: no relevance threshold and no coverage gate.
      params: { ...config.retrieval, minScore: -1, minCoverage: 0, k: 20 },
    });
    // A refused retrieval (too vague) still has a result; only an unranked one has no hits.
    const docs: string[] = [];
    for (const h of result.hits) if (!docs.includes(h.chunk.docId)) docs.push(h.chunk.docId);
    const top = docs.slice(0, k);
    const relevant = new Set(c.relevantDocs);
    const found = top.filter((d) => relevant.has(d)).length;
    recall += found / relevant.size;
    precision += top.length === 0 ? 0 : found / top.length;
    const firstRelevant = docs.findIndex((d) => relevant.has(d));
    rr += firstRelevant === -1 ? 0 : 1 / (firstRelevant + 1);
    if (found > 0) hits++;
  }
  return { k, cases: n, recallAtK: round(recall / n), precisionAtK: round(precision / n), mrr: round(rr / n), hitRate: round(hits / n) };
}

// ------------------------------------------------------------------ answer metrics

export interface CaseResult {
  id: string;
  category: AnswerCase['category'];
  split: AnswerCase['split'];
  pass: boolean;
  /** Why not, when not. */
  failures: string[];
  answer: KnowledgeAnswer;
}

export function judge(c: AnswerCase, answer: KnowledgeAnswer): string[] {
  const failures: string[] = [];
  if (answer.status !== c.expect.status) failures.push(`expected ${c.expect.status}, got ${answer.status}`);
  const text = answer.answer.toLowerCase();
  if (c.expect.status === 'answered' && answer.status === 'answered') {
    for (const s of c.expect.includes ?? []) if (!text.includes(s.toLowerCase())) failures.push(`answer lacks "${s}"`);
    const cited = new Set(answer.citations.map((x) => x.docId));
    for (const d of c.expect.cites ?? []) if (!cited.has(d)) failures.push(`does not cite ${d}`);
    if (c.expect.conflict === true && answer.conflicts.length === 0) failures.push('did not report the disagreement');
  }
  for (const s of c.expect.excludes ?? []) if (text.includes(s.toLowerCase())) failures.push(`answer contains "${s}"`);
  if (answer.status === 'insufficient' && answer.answer !== INSUFFICIENT) failures.push('insufficient answer is not the fixed sentence');
  return failures;
}

export async function runAnswers(index: EvalIndex, config: PipelineConfig, cases: readonly AnswerCase[], model: KnowledgeModel | null): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const c of cases) {
    const answer = await answerQuestion(
      { store: index.store, embedder: index.embedder, model },
      { namespace: EVAL_NAMESPACE, question: c.question, destination: c.destination, asOf: EVAL_AS_OF, params: config.retrieval },
    );
    const failures = judge(c, answer);
    out.push({ id: c.id, category: c.category, split: c.split, pass: failures.length === 0, failures, answer });
  }
  return out;
}

export interface AnswerMetrics {
  cases: number;
  /** Cases that met every expectation. */
  passRate: number;
  /** Of the questions that should be answered, the share that were. */
  answerRecall: number;
  /** Of the questions that should not be answered, the share that were correctly declined. */
  abstainRecall: number;
  /** Of the answers given, the share that were meant to be given. */
  answerPrecision: number;
  /** Of the questions that should be declined, the share that got an answer anyway. */
  falseAnswerRate: number;
  byCategory: Record<string, { cases: number; passRate: number }>;
  bySplit: Record<string, { cases: number; passRate: number }>;
}

export function answerMetrics(cases: readonly AnswerCase[], results: readonly CaseResult[]): AnswerMetrics {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const share = (num: number, den: number) => (den === 0 ? 1 : round(num / den));
  const shouldAnswer = results.filter((r) => byId.get(r.id)!.expect.status === 'answered');
  const shouldDecline = results.filter((r) => byId.get(r.id)!.expect.status === 'insufficient');
  const gaveAnswer = results.filter((r) => r.answer.status === 'answered');
  const group = (key: 'category' | 'split') => {
    const m: Record<string, { cases: number; passRate: number }> = {};
    for (const name of [...new Set(results.map((r) => r[key]))].sort()) {
      const rs = results.filter((r) => r[key] === name);
      m[name] = { cases: rs.length, passRate: share(rs.filter((r) => r.pass).length, rs.length) };
    }
    return m;
  };
  return {
    cases: results.length,
    passRate: share(results.filter((r) => r.pass).length, results.length),
    answerRecall: share(shouldAnswer.filter((r) => r.answer.status === 'answered').length, shouldAnswer.length),
    abstainRecall: share(shouldDecline.filter((r) => r.answer.status === 'insufficient').length, shouldDecline.length),
    answerPrecision: share(gaveAnswer.filter((r) => byId.get(r.id)!.expect.status === 'answered').length, gaveAnswer.length),
    falseAnswerRate: share(shouldDecline.filter((r) => r.answer.status === 'answered').length, shouldDecline.length),
    byCategory: group('category'),
    bySplit: group('split'),
  };
}

export async function runFullAnswerSuite(config: PipelineConfig, model: KnowledgeModel | null = null) {
  const index = await buildIndex(config);
  const results = await runAnswers(index, config, ANSWER_CASES, model);
  return { index, results, metrics: answerMetrics(ANSWER_CASES, results), retrieval: await retrievalMetrics(index, config, ANSWER_CASES) };
}
