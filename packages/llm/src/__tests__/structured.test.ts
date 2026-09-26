import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  LlmInvalidOutputError,
  LlmUnavailableError,
  OpenAiCompatibleProvider,
  TripLlm,
  type ExtractRequest,
  type LlmProvider,
} from '../index.js';

/**
 * The boundary the planning agents use: a schema-checked call that says apart
 * "the model is not there" from "the model answered with something unusable".
 */

const Shape = z.object({ answer: z.string() });
const request = (overrides: Partial<ExtractRequest<{ answer: string }>> = {}): ExtractRequest<{ answer: string }> => ({
  system: 'system',
  input: 'input',
  schema: Shape,
  schemaName: 'shape',
  schemaDescription: 'a shape',
  ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

describe('TripLlm.structured', () => {
  it('reports that no model is configured, as unavailable', async () => {
    await expect(new TripLlm(null).structured(request())).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('passes the request, including its signal, to the provider and returns its answer', async () => {
    const seen: ExtractRequest<unknown>[] = [];
    const provider: LlmProvider = {
      id: 'p', label: 'P', model: 'm', isConfigured: () => true,
      async extract<T>(req: ExtractRequest<T>) {
        seen.push(req as ExtractRequest<unknown>);
        return { data: { answer: 'yes' } as T, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, model: 'm', fromFallback: false };
      },
    };
    const controller = new AbortController();
    const result = await new TripLlm(provider).structured(request({ signal: controller.signal }));
    expect(result.data).toEqual({ answer: 'yes' });
    expect(seen[0]!.signal).toBe(controller.signal);
  });

  it('treats an unusable answer as a kind of unavailability, so older callers still catch it', () => {
    expect(new LlmInvalidOutputError('p', 'bad')).toBeInstanceOf(LlmUnavailableError);
    expect(new LlmInvalidOutputError('p', 'bad').name).toBe('LlmInvalidOutputError');
  });
});

describe('an OpenAI-compatible provider', () => {
  const provider = () =>
    new OpenAiCompatibleProvider({ baseUrl: 'http://llm.test/v1', apiKey: null, model: 'm', maxOutputTokens: 100, timeoutMs: 1000, label: 'Test LLM' });
  const reply = (body: unknown, status = 200) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it('returns a valid structured answer', async () => {
    reply({ choices: [{ message: { content: JSON.stringify({ answer: 'ok' }) } }], model: 'm' });
    const result = await provider().extract(request());
    expect(result.data).toEqual({ answer: 'ok' });
  });

  it('says an empty, non-JSON or wrongly shaped answer is invalid output', async () => {
    reply({ choices: [{ message: { content: '' } }] });
    await expect(provider().extract(request())).rejects.toBeInstanceOf(LlmInvalidOutputError);
    reply({ choices: [{ message: { content: 'not json' } }] });
    await expect(provider().extract(request())).rejects.toBeInstanceOf(LlmInvalidOutputError);
    reply({ choices: [{ message: { content: JSON.stringify({ answer: 5 }) } }] });
    await expect(provider().extract(request())).rejects.toBeInstanceOf(LlmInvalidOutputError);
  });

  it('says a server error is plain unavailability, not invalid output', async () => {
    reply({}, 500);
    const err = await provider().extract(request()).catch((e) => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect(err).not.toBeInstanceOf(LlmInvalidOutputError);
  });

  it('stops when the caller’s signal fires', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const controller = new AbortController();
    const call = provider().extract(request({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    await expect(call).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});
