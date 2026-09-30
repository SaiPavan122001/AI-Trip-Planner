import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { memorySpanExporter, registry, resetMetrics, resetTracing, setupTracing } from '@trip/telemetry';
import { TripLlm } from '../tasks.js';
import { LlmInvalidOutputError, LlmUnavailableError, type ExtractRequest, type LlmProvider, type LlmResult } from '../types.js';

/**
 * What a model call reports (Phase 7): its outcome, latency, tokens and
 * (only if the operator gave prices) an estimated cost, as a span and as
 * metrics, and never the prompt or the answer.
 */

const PROMPT_SECRET = 'MY-PASSPORT-IS-Z1234567-AND-MY-EMAIL-IS-sam@example.com';

let exporter: ReturnType<typeof memorySpanExporter>;
beforeEach(async () => {
  resetMetrics();
  exporter = memorySpanExporter();
  await setupTracing({ serviceName: 'test', environment: 'test', exporter });
});
afterEach(async () => resetTracing());

const req = (over: Partial<ExtractRequest<{ ok: boolean }>> = {}): ExtractRequest<{ ok: boolean }> => ({
  system: 'system prompt',
  input: PROMPT_SECRET,
  schema: z.object({ ok: z.boolean() }),
  schemaName: 'trip_modification',
  schemaDescription: 'd',
  ...over,
});

function model(behaviour: () => Promise<LlmResult<{ ok: boolean }>>): LlmProvider {
  return { id: 'test-model', label: 'Test', model: 'm-1', isConfigured: () => true, extract: behaviour as never };
}
const usage = (inputTokens = 100, outputTokens = 20, cachedInputTokens = 0) => ({ inputTokens, outputTokens, cachedInputTokens });
const answer = (u = usage()): LlmResult<{ ok: boolean }> => ({ data: { ok: true }, usage: u, model: 'm-1', fromFallback: false });

describe('a model call', () => {
  it('is counted and timed by task, and its tokens are counted by direction', async () => {
    await new TripLlm(model(async () => answer(usage(120, 30, 40)))).structured(req());
    expect(registry.value('llm_calls_total', { provider: 'test-model', task: 'trip_modification', outcome: 'ok' })).toBe(1);
    expect(registry.value('llm_call_duration_seconds', { task: 'trip_modification' })).toBe(1);
    expect(registry.value('llm_tokens_total', { direction: 'input' })).toBe(120);
    expect(registry.value('llm_tokens_total', { direction: 'output' })).toBe(30);
    expect(registry.value('llm_tokens_total', { direction: 'cached_input' })).toBe(40);
  });

  it('estimates a cost only from prices the operator supplied, and none otherwise', async () => {
    await new TripLlm(model(async () => answer(usage(1_000_000, 500_000)))).structured(req());
    expect(registry.value('llm_cost_usd_total')).toBe(0);
    await new TripLlm(model(async () => answer(usage(1_000_000, 500_000))), { pricing: { inputPerMillion: 3, outputPerMillion: 15 } }).structured(req());
    expect(registry.value('llm_cost_usd_total', { provider: 'test-model' })).toBeCloseTo(3 + 7.5, 6);
  });

  it('is one span with the model, the task, the outcome and the token counts', async () => {
    await new TripLlm(model(async () => answer(usage(11, 7)))).structured(req());
    const [span] = exporter.getFinishedSpans();
    expect(span!.name).toBe('llm.call');
    expect(span!.attributes).toMatchObject({ 'llm.provider': 'test-model', 'llm.model': 'm-1', 'llm.task': 'trip_modification', 'llm.outcome': 'ok', 'llm.usage.in': 11, 'llm.usage.out': 7 });
  });

  it('never records the prompt, the system instructions or the answer, on the span or in any metric', async () => {
    await new TripLlm(model(async () => answer())).structured(req());
    await new TripLlm(model(async () => Promise.reject(new LlmUnavailableError('test-model', PROMPT_SECRET)))).structured(req()).catch(() => undefined);
    const recorded = JSON.stringify({
      spans: exporter.getFinishedSpans().map((s) => ({ a: s.attributes, e: s.events, st: s.status, n: s.name })),
      metrics: registry.snapshot(),
      text: await registry.render(),
    });
    for (const leaked of ['Z1234567', 'sam@example.com', 'system prompt', PROMPT_SECRET]) expect(recorded).not.toContain(leaked);
  });

  it.each([
    ['a failure', () => Promise.reject(new LlmUnavailableError('test-model', 'down')), 'failed', 'dependency_unavailable'],
    ['unusable output', () => Promise.reject(new LlmInvalidOutputError('test-model', 'not json')), 'invalid_output', 'dependency_unavailable'],
  ] as const)('reports %s as outcome "%s" with error category "%s"', async (_name, behaviour, outcome, category) => {
    await new TripLlm(model(behaviour as never), { breaker: null }).structured(req()).catch(() => undefined);
    expect(registry.value('llm_calls_total', { outcome })).toBe(1);
    expect(registry.value('errors_total', { category, component: 'llm' })).toBe(1);
    expect(exporter.getFinishedSpans()[0]!.status.code).toBe(2);
  });

  it('reports a caller that gave up as cancelled, not as a failure of the model', async () => {
    const controller = new AbortController();
    controller.abort();
    await new TripLlm(model(async () => Promise.reject(new LlmUnavailableError('test-model', 'aborted')))).structured(req({ signal: controller.signal })).catch(() => undefined);
    expect(registry.value('llm_calls_total', { outcome: 'cancelled' })).toBe(1);
    expect(registry.value('llm_calls_total', { outcome: 'failed' })).toBe(0);
  });

  it('reports a call the circuit breaker refused, and that no request was made', async () => {
    let asked = 0;
    const llm = new TripLlm(model(async () => (asked += 1, Promise.reject(new LlmUnavailableError('test-model', 'down')))));
    for (let i = 0; i < 6; i += 1) await llm.structured(req()).catch(() => undefined);
    expect(asked).toBe(4);
    expect(registry.value('llm_calls_total', { outcome: 'failed' })).toBe(4);
    expect(registry.value('llm_calls_total', { outcome: 'skipped_circuit_open' })).toBe(2);
  });

  it('records nothing when no model is configured: there was no call', async () => {
    await new TripLlm(null).structured(req()).catch(() => undefined);
    expect(registry.value('llm_calls_total')).toBe(0);
    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});
