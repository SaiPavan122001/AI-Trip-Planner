import { createHash } from 'node:crypto';
import { ANSWER_PIPELINE } from '../answer.js';
import { SCAN_REASONS, SCAN_RULES_HASH } from '../scan.js';
import { CORPUS, CORPUS_VERSION } from './corpus.js';
import { ANSWER_CASES, DATASET_VERSION } from './dataset.js';
import { GROUNDEDNESS_CASES, GROUNDEDNESS_VERSION, runGroundedness } from './groundedness.js';
import { BASELINE_CONFIG, runFullAnswerSuite, type PipelineConfig } from './harness.js';
import { HALLUCINATION_VERSION, runHallucination } from './hallucination.js';
import { INJECTION_CASES, INJECTION_VERSION, runInjection } from './injection.js';
import { ScriptedModel } from './scripted-model.js';

/**
 * One evaluation run, reduced to what a baseline needs: the numbers (a flat map,
 * each with a direction), a fingerprint of everything that could change them,
 * and a digest of what the pipeline actually said.
 *
 * The fingerprint answers "what did we change?"; the digest answers "did the
 * behaviour change?". A change to the prompt, the chunk size, the embedder, the
 * retrieval settings, the re-ranking formula or the model shows in the
 * fingerprint. A change to code that none of those describes (the stemmer, the
 * screen's patterns, the verifier) shows in the digest. Either one differing
 * from the committed baseline fails the regression check until the baseline is
 * re-recorded on purpose.
 */

export const REPORT_VERSION = 'knowledge-eval/1';
/** Bumped when the re-ranking formula in retrieve.ts changes. */
export const RERANK_FORMULA = 'lexical-blend-0.7-0.3/1';
/** The stand-in model the offline evaluation uses; a live run records the real provider and model instead. */
export const EVAL_MODEL = 'scripted/1';

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

export type Direction = 'higher' | 'lower';

export interface EvalReport {
  reportVersion: string;
  fingerprint: Record<string, unknown>;
  /** Metric name to value. */
  metrics: Record<string, number>;
  /** Which way is better for each metric. */
  directions: Record<string, Direction>;
  /** Hash of what the pipeline answered, case by case. */
  digest: string;
}

export function fingerprintOf(config: PipelineConfig): Record<string, unknown> {
  return {
    corpus: { version: CORPUS_VERSION, hash: sha(CORPUS) },
    answers: { version: DATASET_VERSION, hash: sha(ANSWER_CASES) },
    groundedness: { version: GROUNDEDNESS_VERSION, hash: sha(GROUNDEDNESS_CASES) },
    hallucination: { version: HALLUCINATION_VERSION },
    injection: { version: INJECTION_VERSION, hash: sha(INJECTION_CASES.map((c) => ({ ...c, doc: c.doc && { ...c.doc } }))) },
    chunking: config.chunking,
    retrieval: config.retrieval,
    rerankFormula: RERANK_FORMULA,
    embedder: config.embedder().space,
    prompt: ANSWER_PIPELINE,
    scanner: { reasons: sha(SCAN_REASONS), rules: SCAN_RULES_HASH },
    model: EVAL_MODEL,
  };
}

export async function buildReport(config: PipelineConfig = BASELINE_CONFIG): Promise<EvalReport> {
  const extractive = await runFullAnswerSuite(config, null);
  const withModel = await runFullAnswerSuite(config, new ScriptedModel('faithful'));
  const grounded = runGroundedness();
  const hallucination = await runHallucination(config);
  const injection = await runInjection(config);

  const metrics: Record<string, number> = {};
  const directions: Record<string, Direction> = {};
  const put = (name: string, value: number, direction: Direction) => {
    metrics[name] = Math.round(value * 10_000) / 10_000;
    directions[name] = direction;
  };
  const ratio = (n: number, d: number) => (d === 0 ? 1 : n / d);

  put('retrieval.recallAtK', extractive.retrieval.recallAtK, 'higher');
  put('retrieval.precisionAtK', extractive.retrieval.precisionAtK, 'higher');
  put('retrieval.mrr', extractive.retrieval.mrr, 'higher');
  put('retrieval.hitRate', extractive.retrieval.hitRate, 'higher');

  for (const [name, r] of [['answers.extractive', extractive], ['answers.model', withModel]] as const) {
    put(`${name}.passRate`, r.metrics.passRate, 'higher');
    put(`${name}.answerRecall`, r.metrics.answerRecall, 'higher');
    put(`${name}.abstainRecall`, r.metrics.abstainRecall, 'higher');
    put(`${name}.answerPrecision`, r.metrics.answerPrecision, 'higher');
    put(`${name}.falseAnswerRate`, r.metrics.falseAnswerRate, 'lower');
    put(`${name}.holdoutPassRate`, r.metrics.bySplit['holdout']?.passRate ?? 1, 'higher');
    put(`${name}.tunePassRate`, r.metrics.bySplit['tune']?.passRate ?? 1, 'higher');
  }

  put('groundedness.accuracy', grounded.accuracy, 'higher');
  put('groundedness.falseAcceptRate', grounded.falseAcceptRate, 'lower');
  put('groundedness.falseRejectRate', grounded.falseRejectRate, 'lower');
  put('groundedness.contradictionRecall', grounded.contradictionRecall, 'higher');
  put('groundedness.hardFalseAccepts', grounded.hard.falseAccepts, 'lower');

  put('hallucination.leaks', hallucination.leaks, 'lower');
  put('hallucination.faithfulAcceptRate', ratio(hallucination.faithfulAccepted, hallucination.faithfulRuns), 'higher');

  put('injection.blockRate', ratio(injection.blocked, injection.attacks), 'higher');
  put('injection.blockRateWithoutIngestion', ratio(injection.blockedWithoutIngestion, injection.attacks), 'higher');
  put('injection.blockRateVerifierAlone', ratio(injection.blockedByVerifierAlone, injection.attacks), 'higher');
  put('injection.quarantineRate', ratio(injection.quarantined, injection.documentAttacks), 'higher');
  put('injection.knownLimitationsReached', injection.knownLimitations.reached, 'lower');

  const digest = sha({
    extractive: extractive.results.map((r) => [r.id, r.answer.status, r.answer.answer, r.answer.citations.map((c) => c.chunkId)]),
    model: withModel.results.map((r) => [r.id, r.answer.status, r.answer.answer]),
    grounded: grounded.misjudged,
    hallucination: hallucination.byBehaviour,
    injection: injection.runs.map((r) => [r.id, r.blockedBy, r.reached]),
  });
  return { reportVersion: REPORT_VERSION, fingerprint: fingerprintOf(config), metrics, directions, digest };
}

// ------------------------------------------------------------------ regression check

export interface Comparison {
  /** Metrics that got worse. */
  regressions: Array<{ metric: string; baseline: number; current: number }>;
  /** Metrics that got better (worth recording as the new baseline). */
  improvements: Array<{ metric: string; baseline: number; current: number }>;
  /** Fingerprint parts that differ: what was changed. */
  changed: string[];
  /** The digest differs: the pipeline says something different from before. */
  behaviourChanged: boolean;
  /** Nothing differs at all. */
  identical: boolean;
}

/** Compares a run with the committed baseline. Tolerance is exact: the evaluation is deterministic. */
export function compareReports(baseline: EvalReport, current: EvalReport): Comparison {
  const regressions: Comparison['regressions'] = [];
  const improvements: Comparison['improvements'] = [];
  for (const [metric, was] of Object.entries(baseline.metrics)) {
    const now = current.metrics[metric];
    if (now === undefined) {
      regressions.push({ metric, baseline: was, current: Number.NaN });
      continue;
    }
    const direction = baseline.directions[metric] ?? 'higher';
    if (now === was) continue;
    const worse = direction === 'higher' ? now < was : now > was;
    (worse ? regressions : improvements).push({ metric, baseline: was, current: now });
  }
  for (const metric of Object.keys(current.metrics)) if (!(metric in baseline.metrics)) improvements.push({ metric, baseline: Number.NaN, current: current.metrics[metric]! });
  const changed = Object.keys({ ...baseline.fingerprint, ...current.fingerprint }).filter((k) => JSON.stringify(baseline.fingerprint[k]) !== JSON.stringify(current.fingerprint[k]));
  const behaviourChanged = baseline.digest !== current.digest;
  return { regressions, improvements, changed, behaviourChanged, identical: regressions.length === 0 && improvements.length === 0 && changed.length === 0 && !behaviourChanged };
}
