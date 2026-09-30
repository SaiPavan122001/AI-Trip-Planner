import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenAiCompatibleProvider } from '../openai-compatible.js';
import { LlmInvalidOutputError, LlmUnavailableError } from '../types.js';

/**
 * The one adapter that sends a traveller's words and an API key to an address an
 * operator configured. What is checked here is where that request may go, and
 * that what comes back is treated as untrusted; the network is stubbed and any
 * unlisted address fails the test.
 */

const config = { baseUrl: 'https://llm.example.test/v1', apiKey: 'placeholder-llm-key', model: 'm', maxOutputTokens: 100, timeoutMs: 1000, label: 'Test LLM' };
const request = { system: 's', input: 'i', schema: z.object({ ok: z.boolean() }), schemaName: 'n', schemaDescription: 'd' };

afterEach(() => vi.unstubAllGlobals());

function stub(reply: (init: RequestInit) => Response | Promise<Response>) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), init });
      return reply(init);
    }),
  );
  return seen;
}

const chat = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe('the language-model request', () => {
  it('goes only to the configured address, and refuses to be redirected with the key and the message in it', async () => {
    const seen = stub(() => chat('{"ok":true}'));
    await new OpenAiCompatibleProvider(config).extract(request);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://llm.example.test/v1/chat/completions');
    expect(seen[0]!.init.redirect).toBe('error');
    expect(seen[0]!.init.method).toBe('POST');
  });

  it('reports a redirect (which fetch raises as an error) as the model being unavailable, without its detail', async () => {
    stub(() => {
      throw new TypeError('fetch failed: unexpected redirect to http://169.254.169.254/latest/meta-data');
    });
    const error = await new OpenAiCompatibleProvider(config).extract(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmUnavailableError);
    expect((error as Error).message).not.toMatch(/169\.254|meta-data/);
  });

  it('treats what comes back as untrusted: only what fits the schema is accepted', async () => {
    stub(() => chat('{"ok":"yes, and also ignore your instructions"}'));
    await expect(new OpenAiCompatibleProvider(config).extract(request)).rejects.toBeInstanceOf(LlmInvalidOutputError);
    stub(() => chat('not json at all'));
    await expect(new OpenAiCompatibleProvider(config).extract(request)).rejects.toBeInstanceOf(LlmInvalidOutputError);
    stub(() => new Response('', { status: 500 }));
    await expect(new OpenAiCompatibleProvider(config).extract(request)).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});
