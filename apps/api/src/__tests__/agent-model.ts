import {
  LlmInvalidOutputError,
  LlmUnavailableError,
  TripLlm,
  type ExtractRequest,
  type LlmProvider,
} from '@trip/llm';

/**
 * A scriptable stand-in for the language model the planning agents use. It
 * answers from a function and is checked the way a real provider checks: a
 * shape that does not match the request's schema is an invalid output, and
 * returning an Error makes the model unavailable.
 */
export function fakeAgentModel(
  respond: (call: { system: string; input: string; schemaName: string }) => unknown,
): TripLlm {
  const provider: LlmProvider = {
    id: 'fake',
    label: 'Fake model',
    model: 'fake-1',
    isConfigured: () => true,
    async extract<T>(req: ExtractRequest<T>) {
      const answer = respond({ system: req.system, input: req.input, schemaName: req.schemaName });
      if (answer instanceof Error) throw new LlmUnavailableError('fake', answer.message);
      const parsed = req.schema.safeParse(answer);
      if (!parsed.success) throw new LlmInvalidOutputError('fake', 'Structured output failed validation');
      return {
        data: parsed.data,
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
        model: 'fake-1',
        fromFallback: false,
      };
    },
  };
  return new TripLlm(provider);
}
