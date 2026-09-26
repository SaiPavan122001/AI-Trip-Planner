import { z } from 'zod';
import { PROVIDER_CAPABILITIES } from './provider-status.js';

/**
 * Every provider call returns one of these. There is no code path that turns a
 * failure into invented data: the UI renders the failure verbatim, including
 * which provider failed and when. This is the single most important type in
 * the codebase for the project's "never fabricate travel data" rule.
 */
export const ProviderStatus = z.enum([
  'ok',
  'not_configured',
  'unavailable',
  'no_availability',
  'rate_limited',
  'timeout',
  'invalid_request',
  /** The provider answered, but with something this planner cannot use. */
  'invalid_response',
  'price_changed',
  'booking_unavailable',
  'unsupported_route',
  'unsupported_capability',
]);
export type ProviderStatus = z.infer<typeof ProviderStatus>;

export { CAPABILITY_LABEL, PROVIDER_CAPABILITIES, PROVIDER_STATUS_CLASSES, statusClass, statusLabel } from './provider-status.js';
export type { ProviderStatusClass } from './provider-status.js';

/** What a provider is asked for; see `provider-status.ts`. */
export const ProviderCapability = z.enum(PROVIDER_CAPABILITIES);
export type ProviderCapability = z.infer<typeof ProviderCapability>;

export const ProviderProvenance = z.object({
  /** Adapter id, e.g. "amadeus", "osrm". */
  provider: z.string(),
  /** Human label for display, e.g. "Amadeus Self-Service". */
  providerLabel: z.string(),
  /** When the data was retrieved. Shown next to every price and schedule. */
  retrievedAt: z.string().datetime(),
  /** How long the provider says the data stays valid, if it says anything. */
  validUntil: z.string().datetime().nullable().default(null),
  /** Provider's own reference for the search, useful for support and revalidation. */
  searchId: z.string().nullable().default(null),
  /** Documentation or attribution link required by the provider's terms. */
  attribution: z.string().nullable().default(null),
});
export type ProviderProvenance = z.infer<typeof ProviderProvenance>;

export type ProviderOk<T> = {
  status: 'ok';
  data: T;
  provenance: ProviderProvenance;
  /** Non-fatal notes, e.g. "3 offers dropped: missing baggage details". */
  warnings: string[];
};

export type ProviderFailure = {
  status: Exclude<ProviderStatus, 'ok'>;
  provider: string;
  providerLabel: string;
  /** What was being asked for, when the caller knows. */
  capability?: ProviderCapability;
  /** Message intended for the traveller, plain language, no stack traces. */
  message: string;
  /** Present when the adapter can say when a retry might help. */
  retryAfterSeconds?: number;
  occurredAt: string;
};

export type ProviderResult<T> = ProviderOk<T> | ProviderFailure;

export function isOk<T>(r: ProviderResult<T>): r is ProviderOk<T> {
  return r.status === 'ok';
}

export function ok<T>(
  data: T,
  provenance: ProviderProvenance,
  warnings: string[] = [],
): ProviderOk<T> {
  return { status: 'ok', data, provenance, warnings };
}

export function fail(
  status: Exclude<ProviderStatus, 'ok'>,
  provider: string,
  providerLabel: string,
  message: string,
  retryAfterSeconds?: number,
): ProviderFailure {
  return {
    status,
    provider,
    providerLabel,
    message,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    occurredAt: new Date().toISOString(),
  };
}

/** The same failure, tagged with what was being asked for. */
export function forCapability(failure: ProviderFailure, capability: ProviderCapability): ProviderFailure {
  return failure.capability ? failure : { ...failure, capability };
}

export function notConfigured(
  provider: string,
  providerLabel: string,
  envVars: string[],
): ProviderFailure {
  return fail(
    'not_configured',
    provider,
    providerLabel,
    `${providerLabel} is not configured. Set ${envVars.join(', ')} to enable it. No results are shown for this source rather than estimated ones.`,
  );
}

/** Collects the failures alongside the successes so the UI can report both. */
export function partition<T>(results: ProviderResult<T>[]): {
  ok: ProviderOk<T>[];
  failures: ProviderFailure[];
} {
  const okResults: ProviderOk<T>[] = [];
  const failures: ProviderFailure[] = [];
  for (const r of results) {
    if (isOk(r)) okResults.push(r);
    else failures.push(r);
  }
  return { ok: okResults, failures };
}
