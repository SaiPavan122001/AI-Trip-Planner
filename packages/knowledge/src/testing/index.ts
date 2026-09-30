// Test support for code that uses the knowledge package: the store contract every implementation must pass,
// and the stand-in models the evaluation uses. Imported by tests only (it needs vitest).
export * from './store-contract.js';
export { ScriptedModel, type ScriptedBehaviour } from '../eval/scripted-model.js';
export { CORPUS, EVAL_AS_OF, EVAL_NAMESPACE } from '../eval/corpus.js';
export { ANSWER_CASES } from '../eval/dataset.js';
