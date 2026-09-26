import { AnthropicLlmProvider } from './anthropic.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import { TripLlm } from './tasks.js';
import type { LlmProvider } from './types.js';

export * from './types.js';
export * from './anthropic.js';
export * from './openai-compatible.js';
export * from './tasks.js';

/**
 * Chooses an LLM provider from the environment. Anthropic is the default when
 * a key is present; an OpenAI-compatible endpoint takes over when one is
 * configured, which is what makes a fully self-hosted deployment possible.
 * With neither configured the planner runs on its deterministic fallbacks and
 * says so in the UI rather than pretending to be smarter than it is.
 */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): TripLlm {
  const explicit = env['LLM_PROVIDER'];
  const wantsOpenAi = explicit === 'openai' || (!explicit && Boolean(env['LLM_BASE_URL']));

  let provider: LlmProvider | null = null;
  // One ceiling for either provider; see AnthropicConfig.timeoutMs.
  const timeoutMs = Number(env['LLM_TIMEOUT_MS'] ?? 20_000);

  if (wantsOpenAi && env['LLM_BASE_URL']) {
    provider = new OpenAiCompatibleProvider({
      baseUrl: env['LLM_BASE_URL'].replace(/\/$/, ''),
      apiKey: env['LLM_API_KEY'] ?? null,
      model: env['LLM_MODEL'] ?? 'gpt-4o-mini',
      maxOutputTokens: Number(env['LLM_MAX_OUTPUT_TOKENS'] ?? 2048),
      timeoutMs,
      label: env['LLM_LABEL'] ?? 'Self-hosted LLM',
    });
  } else if (env['ANTHROPIC_API_KEY']) {
    provider = new AnthropicLlmProvider({
      apiKey: env['ANTHROPIC_API_KEY'],
      model: env['ANTHROPIC_MODEL'] ?? 'claude-opus-5',
      maxOutputTokens: Number(env['LLM_MAX_OUTPUT_TOKENS'] ?? 2048),
      timeoutMs,
    });
  }

  return new TripLlm(provider && provider.isConfigured() ? provider : null);
}
