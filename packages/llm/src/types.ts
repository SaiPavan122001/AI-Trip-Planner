import type { z } from 'zod';

/**
 * The LLM boundary.
 *
 * Everything the model is asked to do goes through `extract`: a prompt in, a
 * schema-validated object out. There is deliberately no free-text completion
 * method on this interface, because free text is how model output ends up
 * being displayed to a traveller as if it were fact.
 *
 * The model's role in this system is narrow by design. It classifies intent,
 * pulls structured parameters out of what a person typed, and writes the
 * prose that explains a plan the deterministic engine has already built and
 * validated. It never sources a price, a schedule or an availability.
 */

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the prompt cache, when the provider reports them. */
  cachedInputTokens: number;
}

export interface LlmResult<T> {
  data: T;
  usage: LlmUsage;
  model: string;
  /** True when the deterministic fallback answered instead of a model. */
  fromFallback: boolean;
}

export interface ExtractRequest<T> {
  /** Stable instructions. Kept first and unchanged so it can be cached. */
  system: string;
  /** The volatile part: what the traveller said, plus any context. */
  input: string;
  /** The only shape the caller will accept back. `T` binds to the schema's
   *  output type, so fields with defaults arrive filled in rather than
   *  optional. */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** Name for the structured output, surfaced to the provider. */
  schemaName: string;
  schemaDescription: string;
  /** Per-call ceiling; providers that cannot honour it should fail loudly. */
  maxOutputTokens?: number;
  /** Stops the call when it fires (a cancelled search, an agent's own deadline). */
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  isConfigured(): boolean;
  extract<T>(req: ExtractRequest<T>): Promise<LlmResult<T>>;
}

export class LlmUnavailableError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

/**
 * The model answered, but not in the shape asked for. A kind of unavailability
 * (callers that only care that the model could not help catch the parent), kept
 * apart so an agent can tell "the model is down" from "the model produced
 * something unusable" and record which.
 */
export class LlmInvalidOutputError extends LlmUnavailableError {
  constructor(provider: string, message: string) {
    super(provider, message);
    this.name = 'LlmInvalidOutputError';
  }
}
