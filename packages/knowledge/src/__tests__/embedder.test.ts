import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingError, HashingEmbedder, OpenAiEmbedder, contentTerms, spaceOf, stem } from '../embedder.js';
import { cosine } from '../store.js';

describe('the hashing embedder', () => {
  const e = new HashingEmbedder(256, '1');

  it('names its space by model, version and dimension', () => {
    expect(e.space).toBe('hashing@1:256');
    expect(spaceOf('m', '2', 3)).toBe('m@2:3');
    expect(new HashingEmbedder(128, '1').space).not.toBe(e.space);
    expect(new HashingEmbedder(256, '2').space).not.toBe(e.space);
  });

  it('is deterministic and gives unit-length vectors of the declared dimension', async () => {
    const [a] = await e.embed(['Refunds take 7 to 10 working days']);
    const [b] = await e.embed(['Refunds take 7 to 10 working days']);
    expect(a).toEqual(b);
    expect(a).toHaveLength(256);
    expect(Math.sqrt(a!.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
  });

  it('puts texts that share words closer than texts that share none', async () => {
    const [q, near, far] = await e.embed(['how long does a refund take', 'refunds are returned within 7 working days', 'bicycles are not carried on the railway']);
    expect(cosine(q!, near!)).toBeGreaterThan(cosine(q!, far!));
  });

  it('shares nothing across a paraphrase: this is a lexical embedder, and says so', async () => {
    const [a, b] = await e.embed(['money back', 'refund']);
    expect(Math.abs(cosine(a!, b!))).toBeLessThan(0.2);
  });

  it('gives an empty vector for a text with no content words rather than failing', async () => {
    const [v] = await e.embed(['the of and']);
    expect(v!.every((x) => x === 0)).toBe(true);
  });

  it('rejects an unreasonable dimension', () => {
    expect(() => new HashingEmbedder(4)).toThrow(RangeError);
    expect(() => new HashingEmbedder(100000)).toThrow(RangeError);
  });

  it('stems the common endings so that related forms meet', () => {
    expect(stem('cancelling')).toBe(stem('cancelled'));
    expect(stem('cancelled')).toBe(stem('cancels'));
    expect(stem('cancellation')).toBe(stem('cancel'));
    expect(stem('departure')).toBe(stem('departs'));
    expect(stem('carried')).toBe(stem('carrying'));
    expect(contentTerms('The passengers are carrying 20 kg of luggage')).toEqual(expect.arrayContaining(['passenger', 'carri', '20', 'kg', 'luggag']));
  });
});

describe('the OpenAI-compatible embedder (fetch is stubbed; never verified against a live service)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const config = { baseUrl: 'https://embeddings.example.com/v1', model: 'text-embed', dimension: 3, apiKey: 'k-not-a-real-key' };

  function stub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {}));
    vi.stubGlobal('fetch', fn);
    return fn;
  }
  const ok = (rows: number[][]) => new Response(JSON.stringify({ data: rows.map((embedding, index) => ({ index, embedding })) }), { status: 200 });

  it('posts the texts to /embeddings with the model and dimension, and returns unit vectors in order', async () => {
    const fn = stub(() => ok([[3, 0, 0], [0, 4, 0]]));
    const e = new OpenAiEmbedder(config);
    expect(e.space).toBe('text-embed@1:3');
    const out = await e.embed(['a', 'b']);
    expect(out).toEqual([[1, 0, 0], [0, 1, 0]]);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('https://embeddings.example.com/v1/embeddings');
    expect(JSON.parse(String(init!.body))).toEqual({ model: 'text-embed', input: ['a', 'b'], dimensions: 3 });
    expect((init!.headers as Record<string, string>)['authorization']).toBe('Bearer k-not-a-real-key');
    expect(init!.redirect).toBe('error');
  });

  it('puts results back in order when the service returns them shuffled, and batches large inputs', async () => {
    const fn = stub((_u, init) => {
      const n = (JSON.parse(String(init.body)) as { input: string[] }).input.length;
      const rows = Array.from({ length: n }, (_, i) => ({ index: n - 1 - i, embedding: [n - 1 - i + 1, 0, 0] }));
      return new Response(JSON.stringify({ data: rows }), { status: 200 });
    });
    const e = new OpenAiEmbedder({ ...config, batchSize: 2 });
    const out = await e.embed(['a', 'b', 'c']);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(3);
    expect(out.every((v) => Math.abs(Math.hypot(...v) - 1) < 1e-9)).toBe(true);
  });

  it('fails loudly on a wrong count, a wrong dimension, a bad body, an error status or no connection', async () => {
    const e = new OpenAiEmbedder(config);
    stub(() => ok([[1, 0, 0]]));
    await expect(e.embed(['a', 'b'])).rejects.toThrow(/different number/);
    stub(() => ok([[1, 0]]));
    await expect(e.embed(['a'])).rejects.toThrow(/dimensions/);
    stub(() => new Response('{"oops":true}', { status: 200 }));
    await expect(e.embed(['a'])).rejects.toThrow(/not an embeddings response/);
    stub(() => new Response('nope', { status: 503 }));
    await expect(e.embed(['a'])).rejects.toThrow(/503/);
    stub(() => {
      throw new TypeError('fetch failed');
    });
    await expect(e.embed(['a'])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('does not put the key or the texts in an error message', async () => {
    stub(() => new Response('bad', { status: 500 }));
    const err = await new OpenAiEmbedder(config).embed(['a confidential sentence']).catch((e: Error) => e);
    expect((err as Error).message).not.toContain('k-not-a-real-key');
    expect((err as Error).message).not.toContain('confidential');
  });

  it('refuses plain http to a public host in production, and a non-URL anywhere; an operator may point it at their own internal host', () => {
    expect(() => new OpenAiEmbedder({ ...config, baseUrl: 'http://embeddings.example.com/v1', production: true })).toThrow(/https/);
    expect(() => new OpenAiEmbedder({ ...config, baseUrl: 'not a url' })).toThrow();
    expect(() => new OpenAiEmbedder({ ...config, baseUrl: 'ftp://embeddings.example.com/v1' })).toThrow();
    expect(new OpenAiEmbedder({ ...config, baseUrl: 'http://10.0.0.5:8080/v1', production: true }).space).toBe('text-embed@1:3');
  });
});
