import { zodToJsonSchema } from 'zod-to-json-schema';
import { LlmInvalidOutputError, LlmUnavailableError, type ExtractRequest, type LlmProvider, type LlmResult } from './types.js';

/**
 * Adapter for any service that speaks the OpenAI chat-completions shape:
 * OpenAI itself, Azure OpenAI, Ollama, vLLM, LM Studio, OpenRouter and most
 * self-hosted gateways. It exists so a deployment can run this planner
 * entirely on its own infrastructure.
 *
 * Structured output uses `response_format: json_schema` where the endpoint
 * supports it, and the result is validated against the caller's schema either
 * way, so a gateway that ignores the field fails cleanly instead of returning
 * something unparseable to the planner.
 */

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  maxOutputTokens: number;
  /** Hard ceiling on one request, so a slow endpoint cannot hang a traveller's request. */
  timeoutMs: number;
  label: string;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = 'openai-compatible';
  readonly label: string;
  readonly model: string;

  constructor(private readonly config: OpenAiCompatibleConfig) {
    this.label = config.label;
    this.model = config.model;
  }

  isConfigured(): boolean {
    return Boolean(this.config.baseUrl && this.config.model);
  }

  async extract<T>(req: ExtractRequest<T>): Promise<LlmResult<T>> {
    if (!this.isConfigured()) {
      throw new LlmUnavailableError(this.id, 'LLM_BASE_URL and LLM_MODEL are not both set.');
    }

    const schema = zodToJsonSchema(req.schema, { name: req.schemaName, $refStrategy: 'none' });

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: req.maxOutputTokens ?? this.config.maxOutputTokens,
          temperature: 0,
          response_format: {
            type: 'json_schema',
            json_schema: { name: req.schemaName, schema, strict: true },
          },
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.input },
          ],
        }),
        signal: req.signal
          ? AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs), req.signal])
          : AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      throw new LlmUnavailableError(this.id, `${this.label} could not be reached.`, err);
    }

    if (!response.ok) {
      throw new LlmUnavailableError(
        this.id,
        `${this.label} returned ${response.status}.`,
      );
    }

    const body = (await response.json()) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new LlmInvalidOutputError(this.id, `${this.label} returned an empty response.`);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      throw new LlmInvalidOutputError(this.id, `${this.label} did not return valid JSON.`);
    }

    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) {
      throw new LlmInvalidOutputError(
        this.id,
        `Structured output failed validation: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }

    return {
      data: parsed.data,
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
        cachedInputTokens: 0,
      },
      model: body.model ?? this.config.model,
      fromFallback: false,
    };
  }
}
