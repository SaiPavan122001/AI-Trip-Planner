import { beforeEach, describe, expect, it } from 'vitest';
import type { KnowledgeStore } from '../store.js';
import type { IndexedChunk, StoredDocument } from '../types.js';

/**
 * What every `KnowledgeStore` must do. The in-memory store and the PostgreSQL
 * store (apps/api) both run this, which is what makes them interchangeable, and
 * what keeps a test that passes against the one honest about the other.
 */

const NOW = '2026-09-01T00:00:00.000Z';

export function documentFixture(over: Partial<StoredDocument> = {}): StoredDocument {
  return {
    id: 'doc-a',
    namespace: 'public',
    title: 'Document A',
    url: 'https://example.com/a',
    reference: 'Reference A',
    sourceType: 'operator_policy',
    authority: 3,
    version: 1,
    effectiveDate: '2026-01-01',
    reviewBy: '2027-01-01',
    topic: 'topic-a',
    destination: null,
    contentHash: 'hash-a',
    status: 'active',
    quarantineReasons: [],
    chunkCount: 2,
    previousVersions: [],
    embeddingSpace: 'test@1:4',
    ingestedAt: NOW,
    ...over,
  };
}

export function chunkFixture(doc: StoredDocument, index: number, vector: number[], over: Partial<IndexedChunk> = {}): IndexedChunk {
  return {
    id: `${doc.id}@v${doc.version}#${index}`,
    docId: doc.id,
    version: doc.version,
    index,
    heading: 'Heading',
    text: `text ${index}`,
    start: index * 10,
    end: index * 10 + 6,
    hash: `chunk-hash-${doc.id}-${index}`,
    namespace: doc.namespace,
    space: 'test@1:4',
    vector: Float32Array.from(vector),
    title: doc.title,
    url: doc.url,
    reference: doc.reference,
    sourceType: doc.sourceType,
    authority: doc.authority,
    effectiveDate: doc.effectiveDate,
    reviewBy: doc.reviewBy,
    topic: doc.topic,
    destination: doc.destination,
    ...over,
  };
}

export function describeKnowledgeStore(name: string, make: () => Promise<{ store: KnowledgeStore; cleanup?: () => Promise<void> }>): void {
  describe(`KnowledgeStore contract: ${name}`, () => {
    let store: KnowledgeStore;
    let cleanup: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      if (cleanup) await cleanup();
      ({ store, cleanup } = await make());
    });

    it('stores a document with its chunks and reads it back', async () => {
      const doc = documentFixture();
      await store.commit(doc, [chunkFixture(doc, 0, [1, 0, 0, 0]), chunkFixture(doc, 1, [0, 1, 0, 0])]);
      const back = await store.getDocument('public', 'doc-a');
      expect(back).toMatchObject({ id: 'doc-a', version: 1, status: 'active', contentHash: 'hash-a', chunkCount: 2, embeddingSpace: 'test@1:4' });
      expect(await store.getDocument('public', 'missing')).toBeNull();
      expect(await store.getDocument('other', 'doc-a')).toBeNull();
    });

    it('finds an active document by its content hash, within one namespace', async () => {
      const doc = documentFixture();
      await store.commit(doc, [chunkFixture(doc, 0, [1, 0, 0, 0])]);
      expect((await store.findActiveByHash('public', 'hash-a'))?.id).toBe('doc-a');
      expect(await store.findActiveByHash('public', 'nope')).toBeNull();
      expect(await store.findActiveByHash('other', 'hash-a')).toBeNull();
    });

    it('replaces the previous version atomically: its chunks disappear from search', async () => {
      const v1 = documentFixture();
      await store.commit(v1, [chunkFixture(v1, 0, [1, 0, 0, 0]), chunkFixture(v1, 1, [0, 1, 0, 0])]);
      const v2 = documentFixture({ version: 2, contentHash: 'hash-a2', chunkCount: 1, previousVersions: [{ version: 1, contentHash: 'hash-a', supersededAt: NOW }] });
      await store.commit(v2, [chunkFixture(v2, 0, [1, 0, 0, 0])]);
      const found = await store.search({ namespace: 'public', space: 'test@1:4', vector: [1, 0, 0, 0], k: 10 });
      expect(found.map((f) => f.chunk.id)).toEqual(['doc-a@v2#0']);
      const stored = await store.getDocument('public', 'doc-a');
      expect(stored?.version).toBe(2);
      expect(stored?.previousVersions).toHaveLength(1);
    });

    it('ranks by cosine similarity, best first, with ties broken by chunk id', async () => {
      const a = documentFixture({ id: 'a' });
      const b = documentFixture({ id: 'b', contentHash: 'hb' });
      await store.commit(a, [chunkFixture(a, 0, [1, 0, 0, 0]), chunkFixture(a, 1, [0.6, 0.8, 0, 0])]);
      await store.commit(b, [chunkFixture(b, 0, [1, 0, 0, 0])]);
      const found = await store.search({ namespace: 'public', space: 'test@1:4', vector: [1, 0, 0, 0], k: 10 });
      expect(found.map((f) => f.chunk.id)).toEqual(['a@v1#0', 'b@v1#0', 'a@v1#1']);
      expect(found[0]!.score).toBe(1);
      expect(found[2]!.score).toBe(0.6);
      expect((await store.search({ namespace: 'public', space: 'test@1:4', vector: [1, 0, 0, 0], k: 2 })).map((f) => f.chunk.id)).toEqual(['a@v1#0', 'b@v1#0']);
    });

    it('never crosses a namespace or an embedding space', async () => {
      const pub = documentFixture({ id: 'pub' });
      const other = documentFixture({ id: 'oth', namespace: 'eval', contentHash: 'ho' });
      const newSpace = documentFixture({ id: 'new', contentHash: 'hn', embeddingSpace: 'test@2:4' });
      await store.commit(pub, [chunkFixture(pub, 0, [1, 0, 0, 0])]);
      await store.commit(other, [chunkFixture(other, 0, [1, 0, 0, 0])]);
      await store.commit(newSpace, [chunkFixture(newSpace, 0, [1, 0, 0, 0], { space: 'test@2:4' })]);
      const ids = async (namespace: string, space: string) => (await store.search({ namespace, space, vector: [1, 0, 0, 0], k: 10 })).map((f) => f.chunk.docId);
      expect(await ids('public', 'test@1:4')).toEqual(['pub']);
      expect(await ids('eval', 'test@1:4')).toEqual(['oth']);
      expect(await ids('public', 'test@2:4')).toEqual(['new']);
      expect(await ids('nowhere', 'test@1:4')).toEqual([]);
      expect(await store.spaces('public')).toEqual([
        { space: 'test@1:4', chunks: 1 },
        { space: 'test@2:4', chunks: 1 },
      ]);
    });

    it('applies the metadata filters inside the search', async () => {
      const gov = documentFixture({ id: 'gov', sourceType: 'government_advisory', authority: 4, destination: 'Hill', topic: 'permit', contentHash: 'g' });
      const blog = documentFixture({ id: 'blog', sourceType: 'community_note', authority: 1, destination: 'Hill', topic: 'permit', contentHash: 'b' });
      const generic = documentFixture({ id: 'generic', authority: 3, destination: null, topic: 'other', contentHash: 'x' });
      const elsewhere = documentFixture({ id: 'elsewhere', authority: 3, destination: 'Coast', topic: 'permit', contentHash: 'e' });
      for (const d of [gov, blog, generic, elsewhere]) await store.commit(d, [chunkFixture(d, 0, [1, 0, 0, 0])]);
      const q = (filters: object) => store.search({ namespace: 'public', space: 'test@1:4', vector: [1, 0, 0, 0], k: 10, filters }).then((r) => r.map((x) => x.chunk.docId).sort());
      expect(await q({ minAuthority: 3 })).toEqual(['elsewhere', 'generic', 'gov']);
      expect(await q({ minAuthority: 1 })).toEqual(['blog', 'elsewhere', 'generic', 'gov']);
      expect(await q({ destination: 'hill' })).toEqual(['blog', 'generic', 'gov']);
      expect(await q({ topics: ['permit'] })).toEqual(['blog', 'elsewhere', 'gov']);
      expect(await q({ sourceTypes: ['government_advisory'] })).toEqual(['gov']);
    });

    it('records a quarantined document without replacing an active one, and never searches it', async () => {
      const good = documentFixture();
      await store.commit(good, [chunkFixture(good, 0, [1, 0, 0, 0])]);
      const held = documentFixture({ version: 2, contentHash: 'evil', status: 'quarantined', quarantineReasons: ['instruction_override'], chunkCount: 0, embeddingSpace: null });
      await store.quarantine(held);
      expect((await store.getDocument('public', 'doc-a'))?.version).toBe(1);
      const listed = await store.listDocuments('public');
      expect(listed.map((d) => [d.id, d.version, d.status])).toEqual([
        ['doc-a', 1, 'active'],
        ['doc-a', 2, 'quarantined'],
      ]);
      expect(listed[1]!.quarantineReasons).toEqual(['instruction_override']);
      expect(await store.findActiveByHash('public', 'evil')).toBeNull();
      expect((await store.search({ namespace: 'public', space: 'test@1:4', vector: [1, 0, 0, 0], k: 10 })).map((f) => f.chunk.docId)).toEqual(['doc-a']);
    });

    it('refuses to commit a non-active document or a chunk of another document', async () => {
      const held = documentFixture({ status: 'quarantined' });
      await expect(store.commit(held, [])).rejects.toThrow();
      const doc = documentFixture();
      const stranger = chunkFixture(documentFixture({ id: 'other' }), 0, [1, 0, 0, 0]);
      await expect(store.commit(doc, [stranger])).rejects.toThrow();
    });

    it('keeps vectors as stored (single precision), so a search gives the same numbers in every store', async () => {
      const doc = documentFixture();
      await store.commit(doc, [chunkFixture(doc, 0, [0.1, 0.2, 0.3, 0.4])]);
      const [hit] = await store.search({ namespace: 'public', space: 'test@1:4', vector: [0.1, 0.2, 0.3, 0.4], k: 1 });
      expect(hit!.score).toBeGreaterThan(0.999999);
      expect(Array.from(hit!.chunk.vector).map((x) => Math.round(x * 1e6) / 1e6)).toEqual([0.1, 0.2, 0.3, 0.4]);
    });
  });
}
