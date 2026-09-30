import type { KnowledgeChunk, KnowledgeDocument, Prisma, PrismaClient } from '@prisma/client';
import {
  rankChunks,
  type IndexedChunk,
  type KnowledgeStore,
  type ScoredChunk,
  type SearchQuery,
  type SourceType,
  type StoredDocument,
} from '@trip/knowledge';

/**
 * The knowledge index in PostgreSQL, behind the `KnowledgeStore` interface the
 * in-memory store also implements (both run the same contract test).
 *
 * Search is exact and done in this process: the chunks of one (namespace,
 * embedding space) are read, scored with the same `rankChunks` the in-memory
 * store uses, and cut to k, so the two give identical results. That is the right
 * shape for an operator-curated corpus; it reads every chunk in the space on
 * each question, so it refuses (loudly) past `MAX_SCANNED_CHUNKS` rather than
 * getting slowly worse. Past that, the same interface sits on pgvector or
 * Qdrant (docs/knowledge.md, "Scaling out"). Nothing else in the system would
 * change.
 */

/** Chunks read per search, at most. A corpus larger than this needs an approximate index. */
export const MAX_SCANNED_CHUNKS = 20_000;

type DocumentRow = KnowledgeDocument;
type ChunkRow = KnowledgeChunk;

const toBytes = (vector: Float32Array): Buffer => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
// Copied into a fresh array: a Buffer from the driver may not be aligned for a Float32Array view.
const fromBytes = (bytes: Uint8Array): Float32Array => new Float32Array(Uint8Array.from(bytes).buffer);

function documentOf(row: DocumentRow): StoredDocument {
  return {
    id: row.docId,
    namespace: row.namespace,
    title: row.title,
    url: row.url,
    reference: row.reference,
    sourceType: row.sourceType as SourceType,
    authority: row.authority,
    version: row.version,
    effectiveDate: row.effectiveDate,
    reviewBy: row.reviewBy,
    topic: row.topic,
    destination: row.destination,
    contentHash: row.contentHash,
    status: row.status as StoredDocument['status'],
    quarantineReasons: row.quarantineReasons as string[],
    chunkCount: row.chunkCount,
    previousVersions: row.previousVersions as StoredDocument['previousVersions'],
    embeddingSpace: row.embeddingSpace,
    ingestedAt: row.ingestedAt.toISOString(),
  };
}

function chunkOf(row: ChunkRow): IndexedChunk {
  return {
    id: row.id,
    docId: row.docId,
    version: row.version,
    index: row.position,
    heading: row.heading,
    text: row.text,
    start: row.startChar,
    end: row.endChar,
    hash: row.hash,
    namespace: row.namespace,
    space: row.space,
    vector: fromBytes(row.vector),
    title: row.title,
    url: row.url,
    reference: row.reference,
    sourceType: row.sourceType as SourceType,
    authority: row.authority,
    effectiveDate: row.effectiveDate,
    reviewBy: row.reviewBy,
    topic: row.topic,
    destination: row.destination,
  };
}

function documentData(doc: StoredDocument): Prisma.KnowledgeDocumentUncheckedCreateInput {
  return {
    namespace: doc.namespace,
    docId: doc.id,
    title: doc.title,
    url: doc.url,
    reference: doc.reference,
    sourceType: doc.sourceType,
    authority: doc.authority,
    version: doc.version,
    effectiveDate: doc.effectiveDate,
    reviewBy: doc.reviewBy,
    topic: doc.topic,
    destination: doc.destination,
    contentHash: doc.contentHash,
    status: doc.status,
    quarantineReasons: doc.quarantineReasons,
    chunkCount: doc.chunkCount,
    previousVersions: doc.previousVersions,
    embeddingSpace: doc.embeddingSpace,
    ingestedAt: new Date(doc.ingestedAt),
  };
}

export class PrismaKnowledgeStore implements KnowledgeStore {
  constructor(private readonly prisma: PrismaClient) {}

  async getDocument(namespace: string, id: string): Promise<StoredDocument | null> {
    const row = await this.prisma.knowledgeDocument.findFirst({ where: { namespace, docId: id, status: 'active' } });
    return row ? documentOf(row) : null;
  }

  async findActiveByHash(namespace: string, contentHash: string): Promise<StoredDocument | null> {
    const row = await this.prisma.knowledgeDocument.findFirst({ where: { namespace, contentHash, status: 'active' } });
    return row ? documentOf(row) : null;
  }

  async listDocuments(namespace: string): Promise<StoredDocument[]> {
    const rows = await this.prisma.knowledgeDocument.findMany({ where: { namespace }, orderBy: [{ docId: 'asc' }, { version: 'asc' }] });
    return rows.map(documentOf);
  }

  async commit(doc: StoredDocument, chunks: readonly IndexedChunk[]): Promise<void> {
    if (doc.status !== 'active') throw new Error('only an active document is committed; use quarantine()');
    for (const c of chunks) {
      if (c.namespace !== doc.namespace || c.docId !== doc.id || c.version !== doc.version) throw new Error('a chunk does not belong to the document being committed');
    }
    // One transaction: the previous version and its chunks (deleted with it) are replaced, or nothing changes.
    await this.prisma.$transaction(async (tx) => {
      await tx.knowledgeDocument.deleteMany({ where: { namespace: doc.namespace, docId: doc.id, status: 'active' } });
      const created = await tx.knowledgeDocument.create({ data: documentData(doc) });
      if (chunks.length > 0) {
        await tx.knowledgeChunk.createMany({
          data: chunks.map((c) => ({
            namespace: c.namespace,
            id: c.id,
            docRowId: created.rowId,
            docId: c.docId,
            version: c.version,
            position: c.index,
            heading: c.heading,
            text: c.text,
            startChar: c.start,
            endChar: c.end,
            hash: c.hash,
            space: c.space,
            vector: toBytes(c.vector),
            title: c.title,
            url: c.url,
            reference: c.reference,
            sourceType: c.sourceType,
            authority: c.authority,
            effectiveDate: c.effectiveDate,
            reviewBy: c.reviewBy,
            topic: c.topic,
            destination: c.destination,
          })),
        });
      }
    });
  }

  async quarantine(doc: StoredDocument): Promise<void> {
    if (doc.status !== 'quarantined') throw new Error('only a quarantined document is recorded here');
    const data = documentData(doc);
    // The same attempt recorded twice is one record.
    await this.prisma.knowledgeDocument.upsert({
      where: { namespace_docId_version_contentHash: { namespace: doc.namespace, docId: doc.id, version: doc.version, contentHash: doc.contentHash } },
      create: data,
      update: { quarantineReasons: doc.quarantineReasons, ingestedAt: new Date(doc.ingestedAt) },
    });
  }

  async search(query: SearchQuery): Promise<ScoredChunk[]> {
    const rows = await this.prisma.knowledgeChunk.findMany({
      where: {
        namespace: query.namespace,
        space: query.space,
        ...(query.filters?.minAuthority !== undefined ? { authority: { gte: query.filters.minAuthority } } : {}),
      },
      take: MAX_SCANNED_CHUNKS + 1,
    });
    if (rows.length > MAX_SCANNED_CHUNKS) {
      throw new Error(`The knowledge index has more than ${MAX_SCANNED_CHUNKS} chunks in one embedding space: exact search no longer fits. Move the index to an approximate one (see docs/knowledge.md).`);
    }
    // The remaining filters and the ranking are the shared code, so both stores agree exactly.
    return rankChunks(rows.map(chunkOf), query);
  }

  async spaces(namespace: string): Promise<Array<{ space: string; chunks: number }>> {
    const groups = await this.prisma.knowledgeChunk.groupBy({ by: ['space'], where: { namespace }, _count: { _all: true }, orderBy: { space: 'asc' } });
    return groups.map((g) => ({ space: g.space, chunks: g._count._all }));
  }
}
