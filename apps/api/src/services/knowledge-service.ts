import { answerQuestion, type Embedder, type KnowledgeAnswer, type KnowledgeModel, type KnowledgeStore } from '@trip/knowledge';
import { categoryOfError } from '@trip/telemetry';
import type { Logger } from 'pino';

/**
 * Answers a traveller's question from the curated knowledge index.
 *
 * It is a thin layer: the pipeline is `@trip/knowledge`. What this adds is what
 * belongs to the service and not to the pipeline: the namespace it is allowed to
 * read (fixed by the operator's configuration, never by the caller), a deadline
 * for the whole answer, and one log line per question that says how it went and
 * never what was asked.
 *
 * The planner does not depend on this. A trip is planned, priced and validated
 * without a knowledge answer, and a knowledge answer changes nothing about a
 * trip: it is text with citations, and that is all.
 */
export interface KnowledgeServiceDeps {
  store: KnowledgeStore;
  embedder: Embedder;
  model: KnowledgeModel | null;
  namespace: string;
  timeoutMs: number;
  logger: Logger;
  /** "Today" as YYYY-MM-DD; a function so a test can fix it. */
  today?: () => string;
}

export class KnowledgeService {
  constructor(private readonly deps: KnowledgeServiceDeps) {}

  get namespace(): string {
    return this.deps.namespace;
  }

  get embedderSpace(): string {
    return this.deps.embedder.space;
  }

  async ask(question: string, destination: string | undefined, signal?: AbortSignal): Promise<KnowledgeAnswer> {
    const started = performance.now();
    const deadline = AbortSignal.timeout(this.deps.timeoutMs);
    try {
      const answer = await answerQuestion(
        { store: this.deps.store, embedder: this.deps.embedder, model: this.deps.model },
        {
          namespace: this.deps.namespace,
          question,
          destination,
          asOf: (this.deps.today ?? (() => new Date().toISOString().slice(0, 10)))(),
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        },
      );
      this.deps.logger.info(
        {
          operation: 'knowledge.ask',
          status: answer.status,
          mode: answer.mode,
          insufficientReason: answer.insufficientReason,
          retrievedChunks: answer.stats.retrievedChunks,
          claimsProposed: answer.stats.claimsProposed,
          claimsRejected: answer.stats.claimsRejected,
          durationMs: Math.round(performance.now() - started),
        },
        'Knowledge question answered',
      );
      return answer;
    } catch (err) {
      this.deps.logger.warn({ operation: 'knowledge.ask', errorCategory: categoryOfError(err), durationMs: Math.round(performance.now() - started) }, 'Knowledge question failed');
      throw err;
    }
  }

  /** What an operator sees: whether it can answer, from which space, and how much it holds. Never a document's text. */
  async status(): Promise<{ enabled: true; namespace: string; embedder: string; model: string; documents: number; quarantined: number; spaces: Array<{ space: string; chunks: number }>; embedderMatchesIndex: boolean }> {
    const [docs, spaces] = await Promise.all([this.deps.store.listDocuments(this.deps.namespace), this.deps.store.spaces(this.deps.namespace)]);
    return {
      enabled: true,
      namespace: this.deps.namespace,
      embedder: this.deps.embedder.space,
      model: this.deps.model?.available ? 'configured' : 'none (answers quote the sources)',
      documents: docs.filter((d) => d.status === 'active').length,
      quarantined: docs.filter((d) => d.status === 'quarantined').length,
      spaces,
      // false: the index was built with another embedder, so this one finds nothing in it until documents are ingested again.
      embedderMatchesIndex: spaces.length === 0 || spaces.some((s) => s.space === this.deps.embedder.space),
    };
  }
}

