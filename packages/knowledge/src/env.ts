import { HashingEmbedder, OpenAiEmbedder, type Embedder } from './embedder.js';

/**
 * Chooses the embedder from the environment: an OpenAI-compatible `/embeddings`
 * endpoint when one is configured (`EMBEDDINGS_BASE_URL`, `EMBEDDINGS_MODEL`,
 * `EMBEDDINGS_DIMENSION`, and optionally `EMBEDDINGS_API_KEY` and
 * `EMBEDDINGS_VERSION`), otherwise the offline hashing embedder. Secrets come
 * only from the environment, never from a file in the repository.
 */
export function embedderFromEnv(env: NodeJS.ProcessEnv = process.env): Embedder {
  const baseUrl = env['EMBEDDINGS_BASE_URL'];
  const model = env['EMBEDDINGS_MODEL'];
  if (baseUrl && model) {
    const dimension = Number(env['EMBEDDINGS_DIMENSION']);
    if (!Number.isInteger(dimension) || dimension < 32 || dimension > 8192) {
      throw new Error('EMBEDDINGS_DIMENSION must be set to the number of dimensions the model returns (32 to 8192).');
    }
    return new OpenAiEmbedder({
      baseUrl,
      apiKey: env['EMBEDDINGS_API_KEY'] ?? null,
      model,
      version: env['EMBEDDINGS_VERSION'] ?? '1',
      dimension,
      production: env['NODE_ENV'] === 'production',
    });
  }
  return new HashingEmbedder(Number(env['KNOWLEDGE_HASH_DIMENSION'] ?? 512), '1');
}
