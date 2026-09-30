import { llmFromEnv } from '@trip/llm';
import { embedderFromEnv } from '../env.js';
import { ANSWER_CASES } from './dataset.js';
import { BASELINE_CONFIG, answerMetrics, buildIndex, retrievalMetrics, runAnswers } from './harness.js';

/**
 * LIVE evaluation: the answer suite against the real model and the real embedder
 * named in the environment. It is opt-in and is never part of `npm test`, CI or
 * the regression baseline, because it needs credentials, costs money, and its
 * results vary from run to run.
 *
 *   KNOWLEDGE_EVAL_LIVE=1 ANTHROPIC_API_KEY=... npm run eval -w @trip/knowledge -- --live
 *
 * **No live run has been made in this repository.** The scripted results in
 * docs/knowledge.md say nothing about how a real model behaves; this command is
 * how that is measured.
 */
export async function runLive(): Promise<number> {
  if (process.env['KNOWLEDGE_EVAL_LIVE'] !== '1') {
    console.error('Live evaluation is opt-in. Set KNOWLEDGE_EVAL_LIVE=1 and the model and embedder settings (see .env.example).');
    return 2;
  }
  const llm = llmFromEnv();
  if (!llm.available) {
    console.error('No language model is configured (ANTHROPIC_API_KEY, or LLM_BASE_URL for an OpenAI-compatible endpoint).');
    return 2;
  }
  const embedder = embedderFromEnv();
  const config = { ...BASELINE_CONFIG, name: `live:${embedder.space}`, embedder: () => embedder };
  const index = await buildIndex(config);
  const results = await runAnswers(index, config, ANSWER_CASES, llm);
  console.log(JSON.stringify({ embedder: embedder.space, model: llm.label, answers: answerMetrics(ANSWER_CASES, results), retrieval: await retrievalMetrics(index, config, ANSWER_CASES) }, null, 2));
  for (const r of results) if (!r.pass) console.log('FAIL', r.id, r.failures.join('; '));
  return 0;
}
