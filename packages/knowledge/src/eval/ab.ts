import { DEFAULT_CHUNKING } from '../chunker.js';
import { HashingEmbedder } from '../embedder.js';
import { DEFAULT_RETRIEVAL } from '../retrieve.js';
import { ANSWER_CASES } from './dataset.js';
import { BASELINE_CONFIG, runFullAnswerSuite, type AnswerMetrics, type PipelineConfig, type RetrievalMetrics } from './harness.js';

/**
 * Comparing two pipeline settings on the same questions.
 *
 * Both are run on the identical corpus and dataset, deterministically, and the
 * result names which cases each one gets right that the other does not: a
 * change that improves the average by trading one kind of case for another is
 * visible as such. `tune` and `holdout` results are kept apart, so a setting
 * that wins only on the questions it was chosen with shows.
 */

export interface VariantResult {
  name: string;
  answers: AnswerMetrics;
  retrieval: RetrievalMetrics;
  passing: string[];
}

export interface Comparison {
  a: VariantResult;
  b: VariantResult;
  /** Cases only A passes. */
  aOnly: string[];
  /** Cases only B passes. */
  bOnly: string[];
  /** B minus A, per metric. */
  delta: Record<string, number>;
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

export async function evaluateVariant(config: PipelineConfig): Promise<VariantResult> {
  const { results, metrics, retrieval } = await runFullAnswerSuite(config, null);
  return { name: config.name, answers: metrics, retrieval, passing: results.filter((r) => r.pass).map((r) => r.id) };
}

export async function compareVariants(a: PipelineConfig, b: PipelineConfig): Promise<Comparison> {
  const [ra, rb] = [await evaluateVariant(a), await evaluateVariant(b)];
  const pa = new Set(ra.passing);
  const pb = new Set(rb.passing);
  const flat = (v: VariantResult) => ({
    passRate: v.answers.passRate,
    holdoutPassRate: v.answers.bySplit['holdout']?.passRate ?? 1,
    tunePassRate: v.answers.bySplit['tune']?.passRate ?? 1,
    answerRecall: v.answers.answerRecall,
    abstainRecall: v.answers.abstainRecall,
    falseAnswerRate: v.answers.falseAnswerRate,
    recallAtK: v.retrieval.recallAtK,
    precisionAtK: v.retrieval.precisionAtK,
    mrr: v.retrieval.mrr,
    hitRate: v.retrieval.hitRate,
  });
  const fa = flat(ra);
  const fb = flat(rb);
  const delta = Object.fromEntries(Object.keys(fa).map((k) => [k, round(fb[k as keyof typeof fb] - fa[k as keyof typeof fa])]));
  const ids = ANSWER_CASES.map((c) => c.id);
  return { a: ra, b: rb, aOnly: ids.filter((id) => pa.has(id) && !pb.has(id)), bOnly: ids.filter((id) => pb.has(id) && !pa.has(id)), delta };
}

const withRetrieval = (name: string, retrieval: Partial<typeof DEFAULT_RETRIEVAL>): PipelineConfig => ({ ...BASELINE_CONFIG, name, retrieval: { ...DEFAULT_RETRIEVAL, ...retrieval } });
const withChunking = (name: string, maxChars: number, overlapChars: number): PipelineConfig => ({ ...BASELINE_CONFIG, name, chunking: { ...DEFAULT_CHUNKING, maxChars, overlapChars } });

/** The comparisons the documentation reports: each changes one thing from the baseline. */
export const STANDARD_VARIANTS: PipelineConfig[] = [
  withRetrieval('rerank=none', { rerank: 'none' }),
  withRetrieval('k=2', { k: 2 }),
  withRetrieval('k=6', { k: 6 }),
  withRetrieval('minScore=0.20', { minScore: 0.2 }),
  withRetrieval('minScore=0.40', { minScore: 0.4 }),
  withRetrieval('minCoverage=0.40', { minCoverage: 0.4 }),
  withRetrieval('minCoverage=0.70', { minCoverage: 0.7 }),
  withRetrieval('maxPerDoc=1', { maxPerDoc: 1 }),
  withRetrieval('maxPerDoc=4', { maxPerDoc: 4 }),
  withChunking('chunk=350', 350, 80),
  withChunking('chunk=1200', 1200, 160),
  withChunking('overlap=0', 700, 0),
  { ...BASELINE_CONFIG, name: 'embedder-dim=128', embedder: () => new HashingEmbedder(128, '1') },
];
