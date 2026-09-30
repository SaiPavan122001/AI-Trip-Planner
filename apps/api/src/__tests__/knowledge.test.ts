import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { HashingEmbedder, InMemoryKnowledgeStore, ingestDocument, type KnowledgeStore } from '@trip/knowledge';
import { ScriptedModel } from '@trip/knowledge/testing';
import { TRIP_ID, buildTestApp } from './helpers.js';
import { KnowledgeService } from '../services/knowledge-service.js';

/**
 * `POST /v1/knowledge/ask` (Phase 8): off unless switched on, needs a session,
 * strict about its body, owner-only about a trip, rate limited, and never says
 * more about a failure than that it is unavailable.
 */

const embedder = new HashingEmbedder(256, 'api-test');
const NOW = () => new Date('2026-09-01T00:00:00Z');

async function seeded(store: KnowledgeStore = new InMemoryKnowledgeStore()) {
  const docs = [
    { id: 'refund-policy', title: 'Refund policy', reference: 'Example Co. Refund Policy v1', url: 'https://example.com/refunds', sourceType: 'operator_policy', version: 1, effectiveDate: '2026-01-01', reviewBy: '2027-01-01', text: '# Refunds\n\n## Timeline\n\nApproved refunds are returned to the original payment method within 7 to 10 working days.' },
    { id: 'bengaluru-notice', title: 'Bengaluru visitor notice', reference: 'Example Notice 1', sourceType: 'government_advisory', version: 1, effectiveDate: '2026-01-01', reviewBy: '2027-01-01', destination: 'Bengaluru', text: '# Notice\n\n## Entry\n\nVisitors to the Example Garden in Bengaluru need a ticket bought at the gate.' },
  ];
  for (const d of docs) await ingestDocument({ store, embedder, now: NOW }, { ...d, namespace: 'public' });
  return store;
}

function service(store: KnowledgeStore, over: Partial<ConstructorParameters<typeof KnowledgeService>[0]> = {}) {
  return new KnowledgeService({ store, embedder, model: null, namespace: 'public', timeoutMs: 5000, logger: pino({ level: 'silent' }), today: () => '2026-09-01', ...over });
}

async function withKnowledge(over: Partial<ConstructorParameters<typeof KnowledgeService>[0]> = {}, envVars: Record<string, string> = {}) {
  const store = await seeded();
  const knowledge = service(store, over);
  const t = await buildTestApp({ knowledge, envVars });
  return { ...t, store, knowledge };
}

const ASK = '/v1/knowledge/ask';
const post = (payload: unknown) => ({ method: 'POST' as const, url: ASK, payload: payload as object });
const Q = 'How long does a refund take to reach my payment method?';

describe('POST /v1/knowledge/ask', () => {
  it('does not exist unless KNOWLEDGE_ENABLED is on', async () => {
    const t = await buildTestApp();
    expect(t.ctx.knowledge).toBeNull();
    const res = await t.app.inject(post({ question: Q }));
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('is built from the environment when switched on: an in-memory index (nothing ingested) says "Insufficient verified information."', async () => {
    const t = await buildTestApp({ knowledge: undefined, envVars: { KNOWLEDGE_ENABLED: 'true' } });
    expect(t.ctx.knowledge).not.toBeNull();
    const res = await t.app.inject(post({ question: Q }));
    expect(res.statusCode).toBe(200);
    expect(res.json().answer).toMatchObject({ status: 'insufficient', answer: 'Insufficient verified information.', claims: [], citations: [] });
  });

  it('needs a session: someone who never signed in gets 401 and nothing else', async () => {
    const t = await withKnowledge();
    const res = await t.bare.inject(post({ question: Q }));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
    expect(JSON.stringify(res.json())).not.toContain('refund');
  });

  it('answers with the answer, its citations and nothing of the pipeline’s internals', async () => {
    const t = await withKnowledge();
    const res = await t.app.inject(post({ question: Q }));
    expect(res.statusCode).toBe(200);
    const { answer } = res.json() as { answer: Record<string, unknown> & { citations: Array<Record<string, unknown>> } };
    expect(answer).toMatchObject({ status: 'answered', mode: 'extractive', insufficientReason: null });
    expect(answer['answer']).toContain('7 to 10 working days');
    expect(answer.citations).toEqual([expect.objectContaining({ docId: 'refund-policy', title: 'Refund policy', url: 'https://example.com/refunds', version: 1, sourceType: 'operator_policy' })]);
    expect(Object.keys(answer).sort()).toEqual(['answer', 'citations', 'claims', 'conflicts', 'insufficientReason', 'mode', 'notes', 'status']);
    expect(JSON.stringify(res.json())).not.toMatch(/promptChars|embedCalls|timings|vector/);
  });

  it('says so when nothing verified answers, and does not call it an error', async () => {
    const t = await withKnowledge();
    const res = await t.app.inject(post({ question: 'What is the price of a flight from Delhi to Goa tomorrow?' }));
    expect(res.statusCode).toBe(200);
    expect(res.json().answer).toMatchObject({ status: 'insufficient', answer: 'Insufficient verified information.' });
  });

  it('uses the model when there is one, and still shows only checked claims', async () => {
    const t = await withKnowledge({ model: new ScriptedModel('changed_figure') });
    const res = await t.app.inject(post({ question: Q }));
    const { answer } = res.json() as { answer: { status: string; mode: string; answer: string } };
    expect(answer.status).toBe('answered');
    expect(answer.mode).toBe('extractive');
    expect(answer.answer).toContain('7 to 10 working days');
    expect(answer.answer).not.toContain('14');
  });

  describe('the body', () => {
    it.each([
      ['no question', {}],
      ['an empty question', { question: '   ' }],
      ['a question that is only hidden characters', { question: String.fromCharCode(0x200b).repeat(5) }],
      ['a question that is far too long', { question: 'refund '.repeat(400) }],
      ['a namespace (nothing in a request may name an index)', { question: Q, namespace: 'eval' }],
      ['an owner or user field', { question: Q, userId: 'someone' }],
      ['a number for the question', { question: 12 }],
      ['a trip id that is not a UUID', { question: Q, tripId: 'not-a-uuid' }],
    ])('rejects %s', async (_name, payload) => {
      const t = await withKnowledge();
      const res = await t.app.inject(post(payload));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_failed');
      expect(res.headers['x-error-category']).toBe('validation');
    });

    it('is JSON only', async () => {
      const t = await withKnowledge();
      const res = await t.app.inject({ method: 'POST', url: ASK, payload: 'question=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      expect([400, 415]).toContain(res.statusCode);
    });

    it('cleans the question: hidden characters are removed before it is used', async () => {
      const t = await withKnowledge();
      const zw = String.fromCharCode(0x200b);
      const res = await t.app.inject(post({ question: `How long does a refund${zw} take to reach my payment method?` }));
      expect(res.json().answer.status).toBe('answered');
    });
  });

  describe('a trip', () => {
    it('supplies the destination to prefer, for the caller’s own trip', async () => {
      const t = await withKnowledge();
      const q = 'Do visitors to the Example Garden need a ticket bought at the gate?';
      // The fixture trip goes to Bengaluru, so a document for Bengaluru is in scope.
      const own = await t.app.inject(post({ question: q, tripId: TRIP_ID }));
      expect(own.json().answer.status).toBe('answered');
      expect(own.json().answer.citations[0].docId).toBe('bengaluru-notice');
      // A different destination excludes it.
      const other = await t.app.inject(post({ question: q, destination: 'Mysuru' }));
      expect(other.json().answer.status).toBe('insufficient');
    });

    it('is owner-only: another person’s trip looks exactly like one that does not exist', async () => {
      const t = await withKnowledge();
      const stranger = await t.asStranger();
      const q = { question: Q, tripId: TRIP_ID };
      const theirs = await stranger.app.inject(post(q));
      const missing = await t.app.inject(post({ question: Q, tripId: '99999999-9999-4999-8999-999999999999' }));
      expect(theirs.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(theirs.json()).toEqual(missing.json());
      expect(JSON.stringify(theirs.json())).not.toContain('Bengaluru');
    });

    it('does not create, change or read anything of the trip', async () => {
      const t = await withKnowledge();
      const before = JSON.stringify(await t.repository.getSession(TRIP_ID));
      await t.app.inject(post({ question: Q, tripId: TRIP_ID }));
      expect(JSON.stringify(await t.repository.getSession(TRIP_ID))).toBe(before);
    });
  });

  describe('isolation', () => {
    it('answers only from the namespace the operator configured, whatever documents exist elsewhere', async () => {
      const store = await seeded();
      await ingestDocument({ store, embedder, now: NOW }, { id: 'other-refunds', namespace: 'operator-x', title: 'Other refunds', reference: 'Other', sourceType: 'operator_policy', version: 1, effectiveDate: '2026-01-01', text: '# Refunds\n\n## Timeline\n\nApproved refunds are returned to the original payment method within 30 working days.' });
      const t = await buildTestApp({ knowledge: service(store) });
      const res = await t.app.inject(post({ question: Q }));
      expect(res.json().answer.answer).toContain('7 to 10 working days');
      expect(JSON.stringify(res.json())).not.toContain('30 working');
    });

    it('holds nothing that belongs to a person: a stranger asking gets the same shared answer', async () => {
      const t = await withKnowledge();
      const stranger = await t.asStranger();
      const a = await t.app.inject(post({ question: Q }));
      const b = await stranger.app.inject(post({ question: Q }));
      expect(b.json()).toEqual(a.json());
    });
  });

  describe('when it fails', () => {
    it('reports an unavailable index as 503 with a fixed sentence, a category header, and nothing of the cause', async () => {
      const store = await seeded();
      store.search = async () => {
        throw new Error('connect ECONNREFUSED 10.1.2.3:5432 password=hunter2 at Object.<anonymous> (/repo/secret.ts:1:1)');
      };
      const t = await buildTestApp({ knowledge: service(store) });
      const res = await t.app.inject(post({ question: Q }));
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: { code: 'knowledge_unavailable', message: 'Answers from the knowledge base are unavailable right now. Your trip is not affected.' } });
      expect(res.headers['x-error-category']).toBe('dependency_unavailable');
      expect(res.body).not.toMatch(/ECONNREFUSED|hunter2|secret\.ts|10\.1\.2\.3|at Object/);
    });

    it('does not touch the planner: a trip is still readable and plannable while knowledge answers are down', async () => {
      const store = await seeded();
      store.search = async () => {
        throw new Error('down');
      };
      const t = await buildTestApp({ knowledge: service(store) });
      expect((await t.app.inject(post({ question: Q }))).statusCode).toBe(503);
      expect((await t.app.inject({ method: 'GET', url: `/v1/trips/${TRIP_ID}` })).statusCode).toBe(200);
    });

    it('logs how a question went (status, mode, counts, duration) and never the question, the answer or a source', async () => {
      const lines: string[] = [];
      const logger = pino({ level: 'info' }, { write: (s: string) => lines.push(s) });
      const store = await seeded();
      const t = await buildTestApp({ knowledge: service(store, { logger }) });
      await t.app.inject(post({ question: `${Q} my-secret-marker` }));
      const line = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l['operation'] === 'knowledge.ask');
      expect(line).toMatchObject({ status: expect.any(String), mode: expect.any(String), retrievedChunks: expect.any(Number), durationMs: expect.any(Number) });
      const all = lines.join('');
      expect(all).not.toContain('my-secret-marker');
      expect(all).not.toContain('working days');
    });
  });

  describe('limits', () => {
    it('are per person and per address: the eleventh question in a minute is turned away with how long to wait', async () => {
      const t = await withKnowledge();
      const codes: number[] = [];
      let last: { headers: Record<string, unknown> } | null = null;
      for (let i = 0; i < 12; i++) {
        const res = await t.app.inject(post({ question: Q }));
        codes.push(res.statusCode);
        last = res;
      }
      expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
      expect(codes.slice(10)).toEqual([429, 429]);
      expect(last!.headers['retry-after']).toBeDefined();
    });

    it('do not let a second person borrow the first person’s allowance, or a person the address’s', async () => {
      const t = await withKnowledge();
      for (let i = 0; i < 10; i++) await t.app.inject(post({ question: Q }));
      const stranger = await t.asStranger();
      expect((await stranger.app.inject(post({ question: Q }))).statusCode).toBe(200);
    });
  });

  describe('the operator’s view', () => {
    it('shows whether it is on, what it holds and whether the embedder matches the index, and never a document’s text', async () => {
      const t = await withKnowledge({}, { OPS_TOKEN: 'ops-token-that-is-long-enough-1234567890' });
      const res = await t.bare.inject({ method: 'GET', url: '/ops/status', headers: { authorization: 'Bearer ops-token-that-is-long-enough-1234567890' } });
      expect(res.statusCode).toBe(200);
      const { knowledge } = res.json() as { knowledge: Record<string, unknown> };
      expect(knowledge).toMatchObject({ enabled: true, namespace: 'public', embedder: embedder.space, documents: 2, quarantined: 0, embedderMatchesIndex: true });
      expect(res.body).not.toContain('working days');
    });

    it('says when the index was built with another embedder, so nothing is found until it is ingested again', async () => {
      const t = await withKnowledge({ embedder: new HashingEmbedder(128, 'newer') }, { OPS_TOKEN: 'ops-token-that-is-long-enough-1234567890' });
      const res = await t.bare.inject({ method: 'GET', url: '/ops/status', headers: { authorization: 'Bearer ops-token-that-is-long-enough-1234567890' } });
      expect(res.json().knowledge.embedderMatchesIndex).toBe(false);
      const answer = await t.app.inject(post({ question: Q }));
      expect(answer.json().answer.status).toBe('insufficient');
    });

    it('reports it off when it is off', async () => {
      const t = await buildTestApp({ envVars: { OPS_TOKEN: 'ops-token-that-is-long-enough-1234567890' } });
      const res = await t.bare.inject({ method: 'GET', url: '/ops/status', headers: { authorization: 'Bearer ops-token-that-is-long-enough-1234567890' } });
      expect(res.json().knowledge).toEqual({ enabled: false });
    });
  });
});
