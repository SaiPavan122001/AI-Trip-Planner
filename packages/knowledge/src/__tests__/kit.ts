import { HashingEmbedder } from '../embedder.js';
import { ingestDocument, type IngestResult } from '../ingest.js';
import { InMemoryKnowledgeStore } from '../store.js';

export const NOW = () => new Date('2026-09-01T00:00:00Z');
export const embedder = new HashingEmbedder(256, 't');

export function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'refund-policy',
    namespace: 'public',
    title: 'Refund policy',
    reference: 'Example Co. Refund Policy v1',
    url: 'https://example.com/refunds',
    sourceType: 'operator_policy',
    version: 1,
    effectiveDate: '2026-01-01',
    reviewBy: '2027-01-01',
    topic: 'refunds',
    text: '# Refunds\n\n## Timeline\n\nRefunds are returned to the original payment method within 7 to 10 working days.\nA refund is never paid in cash.',
    ...over,
  };
}

export function freshStore() {
  return new InMemoryKnowledgeStore();
}

export async function put(store: InMemoryKnowledgeStore, over: Record<string, unknown> = {}, e = embedder): Promise<IngestResult> {
  return ingestDocument({ store, embedder: e, now: NOW }, raw(over));
}

// Credential-shaped test data, assembled at run time: a literal would trip the repository's own scan for real credentials
// (`leakage.test.ts`) once the file is tracked. None of these is a credential.
export const FAKE_PROVIDER_KEY = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
export const FAKE_PRIVATE_KEY_HEADER = ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ');
