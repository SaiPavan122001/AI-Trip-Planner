import type { IndexedChunk, ScoredChunk, SearchFilters, StoredDocument } from './types.js';

/**
 * The vector index, as the rest of this package sees it.
 *
 * One implementation is in memory (tests, evaluation, a local run with no
 * database); the other is PostgreSQL, in `apps/api` beside the rest of the
 * persistence. Both must pass `store-contract.ts`, which is what makes them
 * interchangeable. There is one vector store in this system, not two: the
 * PostgreSQL one is the deployed one, the memory one is the test double of it.
 *
 * Search is exact: every chunk in the namespace and space that passes the
 * metadata filters is scored, so results are reproducible and there is no
 * approximate-index recall to account for. That is right for an operator-curated
 * corpus (hundreds to low thousands of chunks). Past that, the same interface
 * can sit on pgvector or Qdrant (docs/knowledge.md, "Scaling out").
 */
export interface KnowledgeStore {
  getDocument(namespace: string, id: string): Promise<StoredDocument | null>;
  /** The active document with this content hash, if any: the same text under another id is a duplicate. */
  findActiveByHash(namespace: string, contentHash: string): Promise<StoredDocument | null>;
  /** Active documents and quarantined attempts, by id then version. */
  listDocuments(namespace: string): Promise<StoredDocument[]>;
  /**
   * Makes `doc` (active) the current version of its id, atomically: the previous
   * version's chunks are removed and `chunks` are written, or nothing changes.
   */
  commit(doc: StoredDocument, chunks: readonly IndexedChunk[]): Promise<void>;
  /** Records a quarantined attempt. It never replaces an active document and is never searchable. */
  quarantine(doc: StoredDocument): Promise<void>;
  search(query: SearchQuery): Promise<ScoredChunk[]>;
  /** Chunks per embedding space in a namespace, so an operator can see a space that has gone stale. */
  spaces(namespace: string): Promise<Array<{ space: string; chunks: number }>>;
}

export interface SearchQuery {
  namespace: string;
  space: string;
  vector: ArrayLike<number>;
  k: number;
  filters?: SearchFilters;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new RangeError('vectors from different embedding spaces cannot be compared');
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function matchesFilters(chunk: IndexedChunk, filters: SearchFilters | undefined): boolean {
  if (!filters) return true;
  if (filters.minAuthority !== undefined && chunk.authority < filters.minAuthority) return false;
  if (filters.sourceTypes && !filters.sourceTypes.includes(chunk.sourceType)) return false;
  if (filters.destination !== undefined && chunk.destination !== null && chunk.destination.toLowerCase() !== filters.destination.toLowerCase()) return false;
  if (filters.topics && (chunk.topic === null || !filters.topics.includes(chunk.topic))) return false;
  return true;
}

/**
 * The one ranking both stores use: cosine similarity, best first, ties broken
 * by chunk id so the order never depends on insertion order or the database.
 * Scores are rounded to six places so the same query gives byte-identical
 * numbers everywhere.
 */
export function rankChunks(candidates: Iterable<IndexedChunk>, query: SearchQuery): ScoredChunk[] {
  const scored: ScoredChunk[] = [];
  for (const chunk of candidates) {
    if (chunk.namespace !== query.namespace || chunk.space !== query.space) continue;
    if (!matchesFilters(chunk, query.filters)) continue;
    scored.push({ chunk, score: Math.round(cosine(chunk.vector, query.vector) * 1e6) / 1e6 });
  }
  scored.sort((x, y) => y.score - x.score || (x.chunk.id < y.chunk.id ? -1 : x.chunk.id > y.chunk.id ? 1 : 0));
  return scored.slice(0, Math.max(0, query.k));
}

const key = (namespace: string, id: string) => `${namespace}/${id}`;

export class InMemoryKnowledgeStore implements KnowledgeStore {
  private readonly documents = new Map<string, StoredDocument>();
  private readonly quarantined = new Map<string, StoredDocument>();
  private chunks = new Map<string, IndexedChunk[]>();

  async getDocument(namespace: string, id: string): Promise<StoredDocument | null> {
    const found = this.documents.get(key(namespace, id));
    return found ? structuredClone(found) : null;
  }

  async findActiveByHash(namespace: string, contentHash: string): Promise<StoredDocument | null> {
    for (const doc of this.documents.values()) {
      if (doc.namespace === namespace && doc.status === 'active' && doc.contentHash === contentHash) return structuredClone(doc);
    }
    return null;
  }

  async listDocuments(namespace: string): Promise<StoredDocument[]> {
    const all = [...this.documents.values(), ...this.quarantined.values()].filter((d) => d.namespace === namespace);
    all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version));
    return structuredClone(all);
  }

  async commit(doc: StoredDocument, chunks: readonly IndexedChunk[]): Promise<void> {
    if (doc.status !== 'active') throw new Error('only an active document is committed; use quarantine()');
    for (const c of chunks) {
      if (c.namespace !== doc.namespace || c.docId !== doc.id || c.version !== doc.version) throw new Error('a chunk does not belong to the document being committed');
    }
    // Copied before it is stored, so a caller that keeps its array cannot change the index.
    const copies = chunks.map((c) => ({ ...c, vector: Float32Array.from(c.vector) }));
    this.documents.set(key(doc.namespace, doc.id), structuredClone(doc));
    this.chunks.set(key(doc.namespace, doc.id), copies);
  }

  async quarantine(doc: StoredDocument): Promise<void> {
    if (doc.status !== 'quarantined') throw new Error('only a quarantined document is recorded here');
    this.quarantined.set(`${key(doc.namespace, doc.id)}@${doc.version}:${doc.contentHash}`, structuredClone(doc));
  }

  async search(query: SearchQuery): Promise<ScoredChunk[]> {
    const all: IndexedChunk[] = [];
    for (const list of this.chunks.values()) all.push(...list);
    return rankChunks(all, query);
  }

  async spaces(namespace: string): Promise<Array<{ space: string; chunks: number }>> {
    const counts = new Map<string, number>();
    for (const list of this.chunks.values()) for (const c of list) if (c.namespace === namespace) counts.set(c.space, (counts.get(c.space) ?? 0) + 1);
    return [...counts].map(([space, chunks]) => ({ space, chunks })).sort((a, b) => (a.space < b.space ? -1 : 1));
  }
}
