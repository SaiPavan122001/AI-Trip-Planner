import { ANSWER_CASES } from './dataset.js';
import { BASELINE_CONFIG, buildIndex, runAnswers, type PipelineConfig } from './harness.js';
import { ScriptedModel } from './scripted-model.js';

/**
 * How long the knowledge pipeline takes, stage by stage, and how much text it
 * would send to a model.
 *
 * What is measured here is *this pipeline's own work*: embedding the question,
 * searching, verifying. The embedder is the offline hashing one and the model is
 * a stand-in that answers instantly, so `embed` and `generate` are the floor,
 * not what a hosted embedder or model will cost. Those are network calls and
 * their latency is theirs to measure (the `knowledge_stage_duration_seconds`
 * histogram records it in a running system). Token counts are estimated at four
 * characters per token and say how much a real call would be asked to read; no
 * price is applied, because there is no built-in price list (the operator's own
 * `LLM_PRICE_*` settings apply in a running system).
 */

export interface StageStats {
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface LatencyReport {
  questions: number;
  repeats: number;
  stages: Record<'embed' | 'search' | 'generate' | 'verify' | 'total', StageStats>;
  /** Embedding calls per question: must be 1 (no repeated retrieval). */
  embedCallsPerQuestion: number;
  /** Questions that asked the model at all (a question with no usable retrieval must not). */
  modelCalls: number;
  answeredWithModel: number;
  estimatedPromptTokens: { mean: number; max: number };
  ingestion: { documents: number; chunks: number; totalMs: number };
}

function stats(values: number[]): StageStats {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const mean = values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return { meanMs: r(mean), p50Ms: r(at(0.5)), p95Ms: r(at(0.95)), maxMs: r(sorted[sorted.length - 1] ?? 0) };
}

export async function measureLatency(config: PipelineConfig = BASELINE_CONFIG, repeats = 5): Promise<LatencyReport> {
  const t0 = performance.now();
  const index = await buildIndex(config);
  const ingestMs = performance.now() - t0;

  const series: Record<string, number[]> = { embed: [], search: [], generate: [], verify: [], total: [] };
  const tokens: number[] = [];
  let embedCalls = 0;
  let questions = 0;
  let modelCalls = 0;
  let withModel = 0;
  for (let i = 0; i < repeats; i++) {
    const model = new ScriptedModel('faithful');
    const results = await runAnswers(index, config, ANSWER_CASES, model);
    for (const r of results) {
      questions++;
      const t = r.answer.stats.timings;
      series['embed']!.push(t.embedMs);
      series['search']!.push(t.searchMs);
      series['generate']!.push(t.generateMs);
      series['verify']!.push(t.verifyMs);
      series['total']!.push(t.totalMs);
      embedCalls += r.answer.stats.embedCalls;
      if (r.answer.stats.modelCalled) {
        modelCalls++;
        tokens.push(Math.ceil(r.answer.stats.promptChars / 4));
      }
      if (r.answer.mode === 'model') withModel++;
    }
  }
  return {
    questions,
    repeats,
    stages: {
      embed: stats(series['embed']!),
      search: stats(series['search']!),
      generate: stats(series['generate']!),
      verify: stats(series['verify']!),
      total: stats(series['total']!),
    },
    embedCallsPerQuestion: embedCalls / questions,
    modelCalls,
    answeredWithModel: withModel,
    estimatedPromptTokens: { mean: Math.round(tokens.reduce((s, v) => s + v, 0) / Math.max(1, tokens.length)), max: Math.max(0, ...tokens) },
    ingestion: { documents: index.ingested.length, chunks: index.ingested.reduce((s, i) => s + i.chunks, 0), totalMs: Math.round(ingestMs * 10) / 10 },
  };
}
