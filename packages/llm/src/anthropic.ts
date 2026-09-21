import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { LlmUnavailableError, type ExtractRequest, type LlmProvider, type LlmResult } from './types.js';

/**
 * Anthropic adapter.
 *
 * Structured output is obtained through a single strict tool rather than by
 * asking for JSON in the prompt: `strict: true` makes the API guarantee the
 * arguments validate against the schema, which removes a whole class of
 * "the model returned almost-JSON" failures. The result is still parsed
 * through the caller's Zod schema, because the boundary should not trust the
 * provider any more than it trusts the model.
 *
 * The system prompt is sent as a cacheable block. These prompts are long,
 * stable and sent on every turn of a conversation, which is exactly the shape
 * prompt caching exists for.
 */

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly id = 'anthropic';
  readonly label = 'Anthropic Claude';
  readonly model: string;
  private readonly client: Anthropic | null;

  constructor(private readonly config: AnthropicConfig) {
    this.model = config.model;
    this.client = config.apiKey ? new Anthropic({ apiKey: config.apiKey }) : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async extract<T>(req: ExtractRequest<T>): Promise<LlmResult<T>> {
    if (!this.client) {
      throw new LlmUnavailableError(this.id, 'ANTHROPIC_API_KEY is not set.');
    }

    const jsonSchema = zodToJsonSchema(req.schema, {
      name: req.schemaName,
      $refStrategy: 'none',
    }) as Record<string, unknown>;
    const parameters = (jsonSchema['definitions'] as Record<string, unknown> | undefined)?.[
      req.schemaName
    ] ?? jsonSchema;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: req.maxOutputTokens ?? this.config.maxOutputTokens,
        // Adaptive thinking: these are small judgement calls where a little
        // reasoning meaningfully improves intent classification, and the
        // model decides for itself how much is warranted.
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
        system: [
          {
            type: 'text',
            text: req.system,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [
          {
            name: req.schemaName,
            description: req.schemaDescription,
            input_schema: {
              ...(parameters as { type: 'object' }),
              additionalProperties: false,
            } as Anthropic.Tool['input_schema'],
            strict: true,
          } as Anthropic.Tool,
        ],
        tool_choice: { type: 'tool', name: req.schemaName },
        messages: [{ role: 'user', content: req.input }],
      });

      if (response.stop_reason === 'refusal') {
        throw new LlmUnavailableError(
          this.id,
          'The model declined this request, so it was handled by the deterministic fallback.',
        );
      }

      const toolUse = response.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      if (!toolUse) {
        throw new LlmUnavailableError(this.id, 'The model returned no structured result.');
      }

      const parsed = req.schema.safeParse(toolUse.input);
      if (!parsed.success) {
        throw new LlmUnavailableError(
          this.id,
          `Structured output failed validation: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        );
      }

      return {
        data: parsed.data,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
        },
        model: response.model,
        fromFallback: false,
      };
    } catch (err) {
      if (err instanceof LlmUnavailableError) throw err;
      if (err instanceof Anthropic.APIError) {
        throw new LlmUnavailableError(
          this.id,
          `Anthropic returned ${err.status}: ${err.message}`,
          err,
        );
      }
      throw new LlmUnavailableError(this.id, 'Anthropic could not be reached.', err);
    }
  }
}
