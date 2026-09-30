import { answerQuestion, type KnowledgeAnswer } from '../answer.js';
import { INSUFFICIENT } from '../types.js';
import { CORPUS, EVAL_AS_OF, EVAL_NAMESPACE } from './corpus.js';
import { ANSWER_CASES } from './dataset.js';
import { BASELINE_CONFIG, buildIndex, type PipelineConfig } from './harness.js';
import { ScriptedModel, type ScriptedBehaviour } from './scripted-model.js';

/**
 * The hallucination set, version 1.
 *
 * Each run gives a model that misbehaves in one fixed way (`scripted-model.ts`)
 * a question the corpus can answer, and looks at what a traveller would be
 * shown. The check is independent of the verifier that is being tested: every
 * sentence of a shown answer must appear word for word in the corpus (a
 * faithful or extractive answer always does), and none of the planted content
 * (an invented price, a changed figure, a made-up link, a promise of certainty,
 * a flipped "not") may appear at all.
 *
 * "Leaks" is the count of runs where something the model made up reached the
 * answer. It should be zero; a non-zero value fails the regression check.
 */

export const HALLUCINATION_VERSION = 'hallucination/1';

/** The behaviours that add something the sources do not say. */
export const BAD_BEHAVIOURS: ScriptedBehaviour[] = ['changed_figure', 'invented_source', 'invented_fact', 'overconfident', 'flipped_negation', 'invented_url'];

/** Questions the corpus answers, so a bad model has something real to distort. */
const QUESTION_IDS = ['n01', 'n03', 'n04', 'n06', 'n07', 'n08', 'n09', 'n12', 'n13', 'n16'];

const PLANTED = ['₹450', 'senior citizens', 'evil.example', 'guaranteed', 'no exceptions'];

/** Every sentence of a shown answer, minus the fixed lead-in this package writes when it shows two sources side by side. */
function sentencesShown(answer: KnowledgeAnswer): string[] {
  return answer.claims.map((c) => c.text.replace(/^.*? \(version \d+, effective [\d-]+\) says: /, ''));
}

const corpusText = CORPUS.map((d) => d.text).join('\n');

export interface HallucinationRun {
  behaviour: ScriptedBehaviour;
  question: string;
  status: KnowledgeAnswer['status'];
  mode: KnowledgeAnswer['mode'];
  claimsRejected: number;
  leaked: string[];
}

export interface HallucinationMetrics {
  runs: number;
  /** Runs where something the model made up reached the answer. */
  leaks: number;
  /** Runs where at least one bad claim was caught and the answer was rebuilt from the sources. */
  caught: number;
  /** Faithful-model runs that were answered by the model (not needlessly rejected). */
  faithfulAccepted: number;
  faithfulRuns: number;
  byBehaviour: Record<string, { runs: number; leaks: number; caught: number }>;
  leakDetails: HallucinationRun[];
}

export async function runHallucination(config: PipelineConfig = BASELINE_CONFIG): Promise<HallucinationMetrics> {
  const index = await buildIndex(config);
  const questions = ANSWER_CASES.filter((c) => QUESTION_IDS.includes(c.id));
  const runs: HallucinationRun[] = [];
  for (const behaviour of [...BAD_BEHAVIOURS, 'faithful'] as ScriptedBehaviour[]) {
    for (const c of questions) {
      const answer = await answerQuestion(
        { store: index.store, embedder: index.embedder, model: new ScriptedModel(behaviour) },
        { namespace: EVAL_NAMESPACE, question: c.question, destination: c.destination, asOf: EVAL_AS_OF, params: config.retrieval },
      );
      const leaked: string[] = [];
      if (answer.status === 'answered') {
        for (const s of sentencesShown(answer)) if (!corpusText.includes(s)) leaked.push(s.slice(0, 80));
        for (const p of PLANTED) if (answer.answer.toLowerCase().includes(p.toLowerCase())) leaked.push(p);
        // A citation must name a document that exists and a chunk of that document: no invented source.
        for (const cite of answer.citations) if (!CORPUS.some((d) => d.id === cite.docId) || !cite.chunkId.startsWith(`${cite.docId}@v`)) leaked.push(cite.chunkId);
      } else if (answer.answer !== INSUFFICIENT) leaked.push('insufficient answer is not the fixed sentence');
      runs.push({ behaviour, question: c.id, status: answer.status, mode: answer.mode, claimsRejected: answer.stats.claimsRejected, leaked });
    }
  }
  const bad = runs.filter((r) => r.behaviour !== 'faithful');
  const faithful = runs.filter((r) => r.behaviour === 'faithful');
  const byBehaviour: HallucinationMetrics['byBehaviour'] = {};
  for (const r of runs) {
    const b = (byBehaviour[r.behaviour] ??= { runs: 0, leaks: 0, caught: 0 });
    b.runs++;
    if (r.leaked.length > 0) b.leaks++;
    if (r.claimsRejected > 0) b.caught++;
  }
  return {
    runs: runs.length,
    leaks: runs.filter((r) => r.leaked.length > 0).length,
    caught: bad.filter((r) => r.claimsRejected > 0).length,
    faithfulAccepted: faithful.filter((r) => r.mode === 'model' && r.status === 'answered').length,
    faithfulRuns: faithful.length,
    byBehaviour,
    leakDetails: runs.filter((r) => r.leaked.length > 0),
  };
}
