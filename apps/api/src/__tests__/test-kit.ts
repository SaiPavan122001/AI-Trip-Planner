import { TripLlm, type ExtractRequest, type LlmProvider, type LlmResult } from '@trip/llm';

/** Small helpers for the HTTP-level tests, kept apart from the app builder. */

/** Keeps the sign-in emails a test triggers, instead of sending them. */
export class CapturingMailer {
  readonly kind = 'webhook' as const;
  readonly canDeliver = true;
  sent: Array<{ to: string; link: string; expiresInMinutes: number }> = [];
  failWith: Error | null = null;

  async sendLoginLink(message: { to: string; link: string; expiresInMinutes: number }): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
  }

  /** The raw token from the most recent link, as the recipient would click it. */
  get lastToken(): string {
    const link = this.sent.at(-1)?.link;
    if (!link) throw new Error('No sign-in email was sent.');
    return new URL(link).searchParams.get('token')!;
  }
}

/** The trip a new visitor would create. */
export const newTripBody = {
  originQuery: 'Hyderabad',
  destinationQuery: 'Bengaluru',
  departureDate: '2030-11-10',
  returnDate: '2030-11-14',
  travelers: { adults: 2 },
};

/** The value of a cookie a response set, or null if it did not set one. */
export function cookieFrom(res: { headers: Record<string, unknown> }, name = 'tp_session'): string | null {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const found = list.find((c) => typeof c === 'string' && c.startsWith(`${name}=`));
  return found ? found.split(';')[0]!.slice(name.length + 1) : null;
}

/** A model that always returns the same structured answer. */
export function modelSaying(output: unknown): TripLlm {
  const provider: LlmProvider = {
    id: 'fixed',
    label: 'Fixed model',
    model: 'fixed',
    isConfigured: () => true,
    async extract<T>(req: ExtractRequest<T>): Promise<LlmResult<T>> {
      return {
        data: req.schema.parse(output),
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
        model: 'fixed',
        fromFallback: false,
      };
    },
  };
  return new TripLlm(provider);
}

interface QuestionLike {
  key: string;
  kind: string;
  options: Array<{ value: string }>;
  min: number | null;
  minSelections: number | null;
}

/** Some valid answer to a question, whatever kind it is. */
function anyValidAnswer(q: QuestionLike): unknown {
  switch (q.kind) {
    case 'single_choice':
      return q.options[0]!.value;
    case 'multi_choice':
    case 'ranking':
      return q.options.slice(0, Math.max(1, q.minSelections ?? 1)).map((o) => o.value);
    case 'number':
      return q.min ?? 1;
    case 'money':
      return { amount: 5_000_000, currency: 'INR' };
    case 'boolean':
      return true;
    case 'time':
      return '09:00';
    default:
      return 'x';
  }
}

/**
 * Answers the questions a trip cannot be planned without, the way a person
 * clicking through would, so a test can go on to plan it.
 */
export async function answerRequired(
  app: { inject: (o: never) => Promise<{ statusCode: number; json: () => { questionnaire: { canPlan: boolean; next: QuestionLike | null } } }> },
  tripId: string,
): Promise<void> {
  let payload: unknown = { key: 'budget.total', value: { amount: 5_000_000, currency: 'INR' } };
  for (let i = 0; i < 12; i += 1) {
    const res = await app.inject({ method: 'POST', url: `/v1/trips/${tripId}/answers`, payload } as never);
    if (res.statusCode !== 200) throw new Error(`Answer rejected: ${JSON.stringify(payload)}`);
    const { canPlan, next } = res.json().questionnaire;
    if (canPlan || !next) return;
    payload = { key: next.key, value: anyValidAnswer(next) };
  }
  throw new Error('The trip still cannot be planned after answering.');
}
