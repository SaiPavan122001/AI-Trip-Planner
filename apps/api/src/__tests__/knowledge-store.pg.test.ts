import { PrismaClient } from '@prisma/client';
import { describe, expect, inject, it } from 'vitest';
import { HashingEmbedder, InMemoryKnowledgeStore, answerQuestion, ingestDocument, type KnowledgeStore } from '@trip/knowledge';
import { ANSWER_CASES, CORPUS, EVAL_AS_OF, EVAL_NAMESPACE, describeKnowledgeStore } from '@trip/knowledge/testing';
import { PrismaKnowledgeStore } from '../repository/knowledge-prisma.js';

/** The knowledge store contract, against a real PostgreSQL with the project's migrations applied. */
describeKnowledgeStore('PostgreSQL', async () => {
  const url = inject('databaseUrl');
  // A guard for TEST_DATABASE_URL: this empties the knowledge tables, so it only runs against a database named as a test database.
  const name = new URL(url).pathname;
  if (!/test/i.test(name)) throw new Error(`Refusing to empty ${name}: the database name must contain "test".`);
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.$executeRawUnsafe('TRUNCATE "knowledge_chunks","knowledge_documents" CASCADE');
  return { store: new PrismaKnowledgeStore(prisma), cleanup: async () => prisma.$disconnect() };
});

describe('the PostgreSQL index and the in-memory one answer identically', () => {
  it('gives the same answers, citations and scores for every question of the evaluation dataset', async () => {
    const url = inject('databaseUrl');
    if (!/test/i.test(new URL(url).pathname)) throw new Error('Refusing to empty a database that is not named as a test database.');
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      await prisma.$executeRawUnsafe('TRUNCATE "knowledge_chunks","knowledge_documents" CASCADE');
      const pg = new PrismaKnowledgeStore(prisma);
      const memory = new InMemoryKnowledgeStore();
      const embedder = new HashingEmbedder(512, '1');
      const now = () => new Date('2026-09-01T00:00:00Z');
      for (const store of [pg, memory]) {
        for (const doc of CORPUS) {
          const result = await ingestDocument({ store, embedder, now }, { ...doc, namespace: EVAL_NAMESPACE });
          expect(result.status).toBe('created');
        }
      }
      expect(await pg.spaces(EVAL_NAMESPACE)).toEqual(await memory.spaces(EVAL_NAMESPACE));

      let compared = 0;
      for (const c of ANSWER_CASES) {
        const ask = (store: KnowledgeStore) =>
          answerQuestion({ store, embedder, model: null }, { namespace: EVAL_NAMESPACE, question: c.question, destination: c.destination, asOf: EVAL_AS_OF });
        const [a, b] = [await ask(pg), await ask(memory)];
        expect({ ...a, stats: undefined }, c.id).toEqual({ ...b, stats: undefined });
        compared++;
      }
      expect(compared).toBe(ANSWER_CASES.length);

      // and a superseded version leaves nothing behind in the database
      const newer = { ...CORPUS[0]!, namespace: EVAL_NAMESPACE, version: CORPUS[0]!.version + 1, effectiveDate: '2026-08-01', text: '# Cancellation policy\n\n## Individual bookings\n\nA traveller may cancel an individual booking at any time before departure without a fee.' };
      expect((await ingestDocument({ store: pg, embedder, now }, newer)).status).toBe('updated');
      const rows = await prisma.knowledgeChunk.findMany({ where: { namespace: EVAL_NAMESPACE, docId: CORPUS[0]!.id } });
      expect(rows.every((r) => r.version === newer.version)).toBe(true);
      const oldAnswer = await answerQuestion({ store: pg, embedder, model: null }, { namespace: EVAL_NAMESPACE, question: 'Is there a fee to cancel an individual booking 10 days before departure?', asOf: EVAL_AS_OF });
      expect(oldAnswer.answer).toContain('at any time before departure');
    } finally {
      await prisma.$disconnect();
    }
  });
});
