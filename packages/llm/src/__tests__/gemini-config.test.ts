import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { llmFromEnv } from '../index.js';

/**
 * Gemini is reached through Google's OpenAI-compatible endpoint with the
 * generic LLM_* settings: there is no GEMINI_* setting, and these tests show
 * which variables the code reads. The network is stubbed; no key is real.
 */

afterEach(() => vi.unstubAllGlobals());

const KEY = 'AIza-FIXTURE-NOT-REAL-KEY';
const GEMINI = {
  LLM_PROVIDER: 'openai',
  LLM_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  LLM_API_KEY: KEY,
  LLM_MODEL: 'gemini-test-model',
  LLM_LABEL: 'Gemini',
};

describe('Gemini through the generic LLM settings', () => {
  it('is off with nothing configured, and the planner uses its rules', () => {
    expect(llmFromEnv({}).available).toBe(false);
  });

  it('is configured by LLM_PROVIDER, LLM_BASE_URL, LLM_API_KEY and LLM_MODEL, and not by a GEMINI_ variable', () => {
    expect(llmFromEnv(GEMINI).available).toBe(true);
    expect(llmFromEnv({ GEMINI_API_KEY: KEY }).available).toBe(false);
  });

  it('sends the key as a bearer token to Google\'s endpoint, with the trailing slash removed', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
      }),
    );
    const llm = llmFromEnv(GEMINI);
    const provider = (llm as unknown as { provider: { extract: (r: unknown) => Promise<unknown> } }).provider;
    await provider.extract({ system: 's', input: 'i', schema: z.object({ ok: z.boolean() }), schemaName: 'n', schemaDescription: 'd' });
    expect(seen[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(seen[0]!.headers['Authorization']).toBe(`Bearer ${KEY}`);
    expect((seen[0]!.body as { model: string }).model).toBe('gemini-test-model');
  });

  it('never shows the key in the provider\'s status', () => {
    expect(JSON.stringify([llmFromEnv(GEMINI).label, llmFromEnv(GEMINI).available])).not.toContain(KEY);
  });
});
