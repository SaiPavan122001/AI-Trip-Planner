import type { z } from 'zod';
import {
  fail,
  forCapability,
  type ProviderCapability,
  type ProviderFailure,
  type ProviderResult,
} from '@trip/shared';
import { InvalidResponseError, toProviderFailure } from './http.js';

/**
 * Defensive handling around provider calls.
 *
 * Three things live here, and each keeps one provider's bad day from becoming
 * the whole search's:
 *
 *  - `readResponse` / `readItems` check what a provider sent against the shape
 *    an adapter's mapping code relies on, so a malformed answer is reported as
 *    one ("unusable response") at the boundary instead of surfacing later as a
 *    crash, or worse as a plausible-looking itinerary.
 *  - `ProviderPolicy` is the port every call goes through. The default,
 *    `IsolatingPolicy`, turns anything a provider throws into a failure and
 *    puts a hard deadline on the call. Retries, fallback between providers,
 *    rate limiting, circuit breaking, caching and metrics are all *policies*:
 *    a later phase supplies one and nothing that calls a provider changes.
 */

/** Parses one provider payload; a mismatch is an `InvalidResponseError`, never a partial object. */
export function readResponse<S extends z.ZodTypeAny>(schema: S, raw: unknown, source: string): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data as z.infer<S>;
  const first = parsed.error.issues[0];
  throw new InvalidResponseError(source, first ? `${first.path.join('.') || 'response'}: ${first.message}` : 'unexpected shape');
}

/**
 * Parses a list one item at a time. An item that does not match is dropped and
 * counted, so one bad row does not discard its neighbours; the caller decides
 * what to do when *every* item was bad (`allInvalid`). The untouched raw item
 * is returned beside the parsed one, for the few places (an Amadeus fare that
 * is later re-priced from its own payload) that must keep every field the
 * provider sent, including ones this planner does not read.
 */
export function readItems<S extends z.ZodTypeAny>(
  items: readonly unknown[],
  schema: S,
): { valid: Array<{ data: z.infer<S>; raw: unknown }>; dropped: number; allInvalid: boolean } {
  const valid: Array<{ data: z.infer<S>; raw: unknown }> = [];
  let dropped = 0;
  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (parsed.success) valid.push({ data: parsed.data as z.infer<S>, raw: item });
    else dropped += 1;
  }
  return { valid, dropped, allInvalid: items.length > 0 && valid.length === 0 };
}

/** The warning shown when some rows of an otherwise good answer were unusable. */
export function droppedWarning(label: string, dropped: number, what: string): string[] {
  return dropped > 0
    ? [`${dropped} ${what} from ${label} could not be read and ${dropped === 1 ? 'was' : 'were'} left out.`]
    : [];
}

// ------------------------------------------------------------------ policy

/** What is being called, for a policy that wants to decide by provider or capability. */
export interface ProviderCall {
  provider: string;
  providerLabel: string;
  capability: ProviderCapability;
  /** For example "searchFlights". */
  operation: string;
}

export interface ProviderPolicy {
  execute<T>(call: ProviderCall, run: () => Promise<ProviderResult<T>>): Promise<ProviderResult<T>>;
}

export interface IsolatingPolicyOptions {
  /** Longest a single call may take, in ms. Null means no backstop beyond the adapter's own. */
  deadlineMs: number | null;
}

/**
 * The default policy: whatever the provider does, the caller gets a
 * `ProviderResult`. It never throws and never waits past the deadline.
 * It does not retry; that is a different policy, and it must not hide from
 * the traveller that a provider was flaky.
 */
export class IsolatingPolicy implements ProviderPolicy {
  constructor(private readonly options: IsolatingPolicyOptions = { deadlineMs: 45_000 }) {}

  async execute<T>(call: ProviderCall, run: () => Promise<ProviderResult<T>>): Promise<ProviderResult<T>> {
    const { deadlineMs } = this.options;
    let timer: NodeJS.Timeout | undefined;
    try {
      const attempt = run().then(
        (r) => r,
        (err: unknown) => toProviderFailure(err, call.provider, call.providerLabel),
      );
      const result =
        deadlineMs === null
          ? await attempt
          : await Promise.race([
              attempt,
              new Promise<ProviderFailure>((resolve) => {
                timer = setTimeout(
                  () =>
                    resolve(
                      fail(
                        'timeout',
                        call.provider,
                        call.providerLabel,
                        `${call.providerLabel} did not answer within ${Math.round(deadlineMs / 1000)} seconds.`,
                      ),
                    ),
                  deadlineMs,
                );
                timer.unref?.();
              }),
            ]);
      return result.status === 'ok' ? result : forCapability(result, call.capability);
    } catch (err) {
      // `run` threw before returning a promise.
      return forCapability(toProviderFailure(err, call.provider, call.providerLabel), call.capability);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** For places that have no registry (small scripts, tests): calls straight through, still never throwing. */
export const passthroughPolicy: ProviderPolicy = new IsolatingPolicy({ deadlineMs: null });
