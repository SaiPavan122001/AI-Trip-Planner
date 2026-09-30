#!/usr/bin/env node
/**
 * Puts curated documents into the knowledge index. An operator action: nothing
 * a traveller sends can reach this, and there is no HTTP endpoint for it.
 *
 *   npm run build
 *   DATABASE_URL=postgresql://... npm run ingest:knowledge -w @trip/api -- ./docs.json [--namespace public] [--dry-run]
 *
 * The manifest is a JSON file: an array of documents, or { "documents": [...] }.
 * Each document has the fields in docs/knowledge.md ("Ingestion"); its text is
 * either inline (`text`) or in a file next to the manifest (`textFile`). The
 * namespace comes from the command line or KNOWLEDGE_NAMESPACE, never from a
 * document.
 *
 * Every document goes through the same checks whatever its source: a schema, a
 * screen for instruction-like text, secrets and personal data (held in
 * quarantine, with reasons, never indexed), version and effective-date rules
 * (an older version never replaces a newer one), and a duplicate check. The
 * embedder is the one in the environment (EMBEDDINGS_*; the offline hashing
 * embedder if none), and the vectors it makes are stored with its name, so an
 * index is never searched with a different embedder.
 *
 * Exit status: 0 if every document was stored, was already there, or was
 * re-embedded; 1 if any was rejected or held; 2 for a problem with the run.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { embedderFromEnv, ingestDocument, InMemoryKnowledgeStore } from '@trip/knowledge';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const manifestPath = args.find((a) => !a.startsWith('--') && a !== option('--namespace'));

if (!manifestPath) {
  console.error('Usage: ingest-knowledge <manifest.json> [--namespace public] [--dry-run]');
  process.exit(2);
}

const namespace = option('--namespace') ?? process.env.KNOWLEDGE_NAMESPACE ?? 'public';
const dryRun = flag('--dry-run');
const manifestFile = resolve(manifestPath);

let documents;
try {
  const parsed = JSON.parse(readFileSync(manifestFile, 'utf8'));
  documents = Array.isArray(parsed) ? parsed : parsed.documents;
  if (!Array.isArray(documents)) throw new Error('the manifest must be an array of documents or { "documents": [...] }');
} catch (err) {
  console.error(`Could not read ${manifestFile}: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
}

let prisma = null;
let store;
if (dryRun || !process.env.DATABASE_URL) {
  if (!dryRun) {
    console.error('DATABASE_URL is not set. Nothing would be kept; use --dry-run to check a manifest without a database.');
    process.exit(2);
  }
  store = new InMemoryKnowledgeStore();
} else {
  const { PrismaKnowledgeStore } = await import('../dist/repository/knowledge-prisma.js');
  prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  store = new PrismaKnowledgeStore(prisma);
}

const embedder = embedderFromEnv(process.env);
console.log(`${dryRun ? 'Dry run (no database)' : 'Ingesting'} into namespace "${namespace}" with embedder ${embedder.space}`);

const rows = [];
let bad = 0;
try {
  for (const entry of documents) {
    const { textFile, namespace: _ignored, ...doc } = entry;
    if (textFile !== undefined) {
      try {
        doc.text = readFileSync(resolve(dirname(manifestFile), textFile), 'utf8');
      } catch {
        rows.push({ id: doc.id ?? '(no id)', status: 'unreadable', chunks: 0, reasons: `could not read ${textFile}` });
        bad++;
        continue;
      }
    }
    const result = await ingestDocument({ store, embedder }, { ...doc, namespace });
    rows.push({ id: result.id ?? doc.id ?? '(no id)', version: result.version, status: result.status, chunks: result.chunks, reasons: result.reasons.join('; ') });
    if (!['created', 'updated', 'unchanged', 'reindexed'].includes(result.status)) bad++;
  }
} finally {
  await prisma?.$disconnect();
}
console.table(rows);
if (bad > 0) console.error(`${bad} document(s) were not stored (see status and reasons above). A quarantined document is recorded for review and is never searchable.`);
process.exit(bad > 0 ? 1 : 0);
