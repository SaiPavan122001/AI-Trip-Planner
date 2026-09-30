import { chunkDocument, embeddingText, DEFAULT_CHUNKING, type ChunkOptions } from './chunker.js';
import type { Embedder } from './embedder.js';
import type { KnowledgeStore } from './store.js';
import type { IndexedChunk, StoredDocument } from './types.js';
import { prepareDocument, storedFrom } from './validate.js';

/**
 * Putting a document into the index, under rules an operator can rely on:
 *
 *  - **Newer never loses to older.** A submission with a lower version than the
 *    one held is refused; so is a higher version whose effective date is
 *    earlier (a version number can be typed wrongly, a date that goes backwards
 *    is a sign of it). Same version with different text is refused too: say what
 *    changed by raising the version.
 *  - **The same text is stored once.** An identical body under another id is
 *    refused as a duplicate; the same body again under the same id and version
 *    is "unchanged" and does nothing (unless the embedder has changed, when it
 *    is embedded again into the new space).
 *  - **Nothing half-written.** Chunks are embedded before anything is stored,
 *    and the store swaps the old version for the new one in one step: a failed
 *    embedding call leaves the previous version in place.
 *  - **Suspicious text is held, not indexed.** See `scan.ts`.
 *
 * Ingestion is an operator action (a script), not an API endpoint: nothing a
 * traveller sends can reach it.
 */

export type IngestStatus =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'reindexed'
  | 'quarantined'
  | 'rejected_invalid'
  | 'rejected_older'
  | 'rejected_conflict'
  | 'rejected_duplicate';

export interface IngestResult {
  status: IngestStatus;
  id: string | null;
  version: number | null;
  chunks: number;
  /** Reason codes or problems. Never the text of the document. */
  reasons: string[];
}

export interface IngestDeps {
  store: KnowledgeStore;
  embedder: Embedder;
  chunking?: ChunkOptions;
  now?: () => Date;
}

const MAX_CHUNKS = 500;

export async function ingestDocument(deps: IngestDeps, raw: unknown): Promise<IngestResult> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const prepared = prepareDocument(raw);
  if (!prepared.ok) return { status: 'rejected_invalid', id: null, version: null, chunks: 0, reasons: prepared.problems };
  const { input, text, contentHash, quarantine } = prepared;
  const result = (status: IngestStatus, chunks: number, reasons: string[] = []): IngestResult => ({ status, id: input.id, version: input.version, chunks, reasons });

  if (quarantine.length > 0) {
    await deps.store.quarantine(
      storedFrom(input, { contentHash, status: 'quarantined', quarantineReasons: quarantine, chunkCount: 0, embeddingSpace: null, ingestedAt: now }),
    );
    return result('quarantined', 0, quarantine);
  }

  const existing = await deps.store.getDocument(input.namespace, input.id);
  let reindex = false;
  if (existing) {
    if (input.version < existing.version) return result('rejected_older', 0, [`version ${input.version} is older than the held version ${existing.version}`]);
    if (input.version === existing.version) {
      if (existing.contentHash !== contentHash) return result('rejected_conflict', 0, ['same version, different text: raise the version']);
      if (existing.embeddingSpace === deps.embedder.space) return result('unchanged', existing.chunkCount);
      reindex = true;
    } else if (input.effectiveDate < existing.effectiveDate) {
      return result('rejected_older', 0, [`effective date ${input.effectiveDate} is earlier than the held version's ${existing.effectiveDate}`]);
    }
  }

  const twin = await deps.store.findActiveByHash(input.namespace, contentHash);
  if (twin && twin.id !== input.id) return result('rejected_duplicate', 0, [`identical text is already held as "${twin.id}"`]);

  const chunks = chunkDocument(input.id, input.version, input.title, text, deps.chunking ?? DEFAULT_CHUNKING);
  if (chunks.length === 0) return result('rejected_invalid', 0, ['the document has no text to index']);
  if (chunks.length > MAX_CHUNKS) return result('rejected_invalid', 0, [`the document makes ${chunks.length} chunks; the limit is ${MAX_CHUNKS}`]);

  const vectors = await deps.embedder.embed(chunks.map((c) => embeddingText(input.title, c)));
  if (vectors.length !== chunks.length || vectors.some((v) => v.length !== deps.embedder.dimension)) {
    throw new Error('the embedder returned vectors that do not match its declared dimension');
  }

  const doc: StoredDocument = storedFrom(input, {
    contentHash,
    status: 'active',
    quarantineReasons: [],
    chunkCount: chunks.length,
    embeddingSpace: deps.embedder.space,
    ingestedAt: now,
    previousVersions:
      existing && !reindex
        ? [...existing.previousVersions, { version: existing.version, contentHash: existing.contentHash, supersededAt: now }]
        : (existing?.previousVersions ?? []),
  });
  const indexed: IndexedChunk[] = chunks.map((c, i) => ({
    ...c,
    namespace: doc.namespace,
    space: deps.embedder.space,
    vector: Float32Array.from(vectors[i]!),
    title: doc.title,
    url: doc.url,
    reference: doc.reference,
    sourceType: doc.sourceType,
    authority: doc.authority,
    effectiveDate: doc.effectiveDate,
    reviewBy: doc.reviewBy,
    topic: doc.topic,
    destination: doc.destination,
  }));
  await deps.store.commit(doc, indexed);
  return result(reindex ? 'reindexed' : existing ? 'updated' : 'created', chunks.length);
}
