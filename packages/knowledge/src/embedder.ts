import { z } from 'zod';
import { validateConfiguredUrl } from '@trip/providers';

/**
 * Turning text into vectors.
 *
 * Vectors are only comparable with vectors made the same way, so every
 * embedder names its **space**: `<model>@<version>:<dimension>`. Chunks are
 * stored with the space they were embedded in, a search is asked in exactly one
 * space, and the store never compares across two. Changing the model, its
 * version or its dimension therefore never mixes old and new vectors: the old
 * chunks stay in their space, invisible to the new embedder, until the
 * documents are ingested again (docs/knowledge.md, "Changing the embedder").
 */
export interface Embedder {
  readonly model: string;
  readonly version: string;
  readonly dimension: number;
  readonly space: string;
  /** One unit-length vector per text, in order. */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}

export const spaceOf = (model: string, version: string, dimension: number): string => `${model}@${version}:${dimension}`;

const STOPWORDS = new Set(
  'a an and are as at be but by can do does for from had has have how i if in into is it its may me my of on or our so than that the their them then there these they this to us was we were what when where which who will with you your not no yes any all much many long take did should would could must'.split(' '),
);

/** A cheap, dependency-free stemmer: enough that "cancelling", "cancelled" and "cancels" meet. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 7 && w.endsWith('ation')) w = w.slice(0, -5);
  else if (w.length > 6 && w.endsWith('ure')) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('y')) w = `${w.slice(0, -1)}i`;
  if (w.length > 3 && /(.)\1$/.test(w) && !/ss$/.test(w)) w = w.slice(0, -1);
  return w;
}

/** The words that carry meaning in a text: lower case, no stop words, stemmed. Used by search and by the answer checks. */
export function contentTerms(text: string): string[] {
  const words = text.toLowerCase().normalize('NFKC').match(/[a-z0-9₹%]+(?:[.,][0-9]+)*/g) ?? [];
  return words.filter((w) => !STOPWORDS.has(w) && w.length > 1).map(stem);
}

function fnv1a(text: string, seed: number): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A deterministic, offline embedder: feature hashing of stemmed words and word
 * pairs. It needs no network, no model file and no key, gives the same vector
 * for the same text on every machine, and so is what tests, evaluation and a
 * fresh local install use.
 *
 * It measures shared vocabulary, not meaning. "Refund" and "money back" share
 * nothing to it. That is stated plainly because it bounds what the baseline
 * evaluation numbers mean: they measure the pipeline (chunking, filtering,
 * gating, verification), and a learned embedder is expected to do better on
 * paraphrase. Swapping one in is a configuration change (`OpenAiEmbedder`), and
 * the evaluation can then be re-run on the same dataset and compared.
 */
export class HashingEmbedder implements Embedder {
  readonly model = 'hashing';
  readonly version: string;
  readonly space: string;

  constructor(readonly dimension = 512, version = '1') {
    if (!Number.isInteger(dimension) || dimension < 32 || dimension > 8192) throw new RangeError('dimension must be between 32 and 8192');
    this.version = version;
    this.space = spaceOf(this.model, version, dimension);
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => this.vector(t));
  }

  private vector(text: string): number[] {
    const v = new Array<number>(this.dimension).fill(0);
    const terms = contentTerms(text);
    const add = (feature: string, weight: number) => {
      const bucket = fnv1a(feature, 0) % this.dimension;
      const sign = (fnv1a(feature, 0x9e3779b9) & 1) === 0 ? 1 : -1;
      v[bucket]! += sign * weight;
    };
    const counts = new Map<string, number>();
    for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);
    // Sublinear term weight: the tenth mention of a word is not ten times the first.
    for (const [t, n] of counts) add(t, 1 + Math.log(n));
    for (let i = 0; i + 1 < terms.length; i++) add(`${terms[i]} ${terms[i + 1]}`, 0.5);
    return normalise(v);
  }
}

export function normalise(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  return norm === 0 ? v : v.map((x) => x / norm);
}

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export interface OpenAiEmbedderConfig {
  baseUrl: string;
  apiKey?: string | null;
  model: string;
  /** Recorded as part of the space: bump it when the provider silently changes what a model name means. */
  version?: string;
  dimension: number;
  timeoutMs?: number;
  batchSize?: number;
  production?: boolean;
}

const EmbeddingsResponse = z.object({
  data: z.array(z.object({ index: z.number().int().min(0), embedding: z.array(z.number().finite()) })).min(1),
});

/**
 * An OpenAI-compatible `/embeddings` endpoint (hosted or self-hosted). **Not
 * verified against a live service in this repository**: the tests stub `fetch`.
 * Every response is read through a schema, and its vector count and dimension
 * are checked against what was asked, so a provider that returns something else
 * fails loudly instead of writing vectors that would never match.
 */
export class OpenAiEmbedder implements Embedder {
  readonly model: string;
  readonly version: string;
  readonly dimension: number;
  readonly space: string;
  private readonly baseUrl: string;

  constructor(private readonly config: OpenAiEmbedderConfig) {
    this.baseUrl = validateConfiguredUrl('EMBEDDINGS_BASE_URL', config.baseUrl, { production: config.production ?? false }).replace(/\/$/, '');
    this.model = config.model;
    this.version = config.version ?? '1';
    this.dimension = config.dimension;
    this.space = spaceOf(this.model, this.version, this.dimension);
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const out: number[][] = [];
    const size = Math.max(1, this.config.batchSize ?? 64);
    for (let i = 0; i < texts.length; i += size) {
      out.push(...(await this.batch(texts.slice(i, i + size), signal)));
    }
    return out;
  }

  private async batch(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.model, input: texts, dimensions: this.dimension }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'error',
      });
    } catch {
      throw new EmbeddingError('The embedding service could not be reached.');
    }
    if (!res.ok) throw new EmbeddingError(`The embedding service answered ${res.status}.`);
    const parsed = EmbeddingsResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new EmbeddingError('The embedding service sent something that is not an embeddings response.');
    const rows = [...parsed.data.data].sort((a, b) => a.index - b.index);
    if (rows.length !== texts.length) throw new EmbeddingError('The embedding service returned a different number of vectors than texts.');
    return rows.map((r) => {
      if (r.embedding.length !== this.dimension) throw new EmbeddingError(`The embedding service returned ${r.embedding.length} dimensions, expected ${this.dimension}.`);
      return normalise(r.embedding);
    });
  }
}
