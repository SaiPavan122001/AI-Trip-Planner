import { describe, expect, it } from 'vitest';
import { InMemoryKnowledgeStore, cosine, rankChunks } from '../store.js';
import { chunkFixture, describeKnowledgeStore, documentFixture } from '../testing/store-contract.js';

describeKnowledgeStore('in memory', async () => ({ store: new InMemoryKnowledgeStore() }));

describe('the in-memory store', () => {
  it('cannot be altered through what it returned or what it was given', async () => {
    const store = new InMemoryKnowledgeStore();
    const doc = documentFixture();
    const chunk = chunkFixture(doc, 0, [1, 0, 0, 0]);
    await store.commit(doc, [chunk]);
    chunk.vector[0] = 0; // the caller's copy changes
    doc.title = 'changed';
    const [hit] = await store.search({ namespace: 'public', space: 'test@1:4', vector: [1, 0, 0, 0], k: 1 });
    expect(hit!.score).toBe(1);
    expect((await store.getDocument('public', 'doc-a'))!.title).toBe('Document A');
    const read = (await store.getDocument('public', 'doc-a'))!;
    read.title = 'tampered';
    expect((await store.getDocument('public', 'doc-a'))!.title).toBe('Document A');
  });
});

describe('ranking', () => {
  it('scores cosine similarity and refuses to compare vectors of different lengths', () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
    expect(() => cosine([1, 0], [1, 0, 0])).toThrow(RangeError);
  });

  it('gives the same order whatever order the chunks arrive in', () => {
    const doc = documentFixture();
    const chunks = [0, 1, 2, 3].map((i) => chunkFixture(doc, i, [1, i / 10, 0, 0]));
    const q = { namespace: 'public', space: 'test@1:4', vector: [1, 0, 0, 0], k: 4 };
    const forward = rankChunks(chunks, q).map((s) => s.chunk.id);
    const backward = rankChunks([...chunks].reverse(), q).map((s) => s.chunk.id);
    expect(forward).toEqual(backward);
    // equal scores fall back to the chunk id
    const twins = [chunkFixture(doc, 1, [1, 0, 0, 0]), chunkFixture(doc, 0, [1, 0, 0, 0])];
    expect(rankChunks(twins, q).map((s) => s.chunk.id)).toEqual(['doc-a@v1#0', 'doc-a@v1#1']);
  });
});
