import { addSpanEvent, metrics } from '@trip/telemetry';
import { fail, isOk, type ProviderCapability, type ProviderFailure, type ProviderResult } from '@trip/shared';
import type { ProviderPolicy } from './guard.js';
import type { BaseProvider, ProviderDescriptor, RouteRequest, RouteResult, RoutingProvider } from './types.js';

/**
 * Fallback between providers that can answer the same question.
 *
 * Most capabilities here have one provider, or are searches where every
 * provider's inventory is wanted and all are asked at once (`sweepProviders`).
 * Fallback is for the other kind: one answer is wanted and any of several
 * providers can give it, such as the distance and time of a drive when both
 * Google and OSRM are connected. The first provider that answers wins; if it
 * failed, the next is tried; and the answer says which provider it came from
 * (its provenance is that provider's own) and what went wrong with the ones
 * before it. A failure is never hidden, and nothing is ever invented: if every
 * provider fails, the result is a failure that lists them all.
 *
 * Each provider is asked through the registry's policy, so a provider whose
 * circuit is open is skipped without being called, and each call has its own
 * deadline inside the time the whole question has.
 */

export interface FallbackStep<T> {
  provider: BaseProvider;
  capability: ProviderCapability;
  operation: string;
  ask: () => Promise<ProviderResult<T>>;
}

export async function firstAnswer<T>(policy: ProviderPolicy, steps: readonly FallbackStep<T>[]): Promise<ProviderResult<T>> {
  const failures: ProviderFailure[] = [];
  for (const step of steps) {
    const d = step.provider.descriptor;
    const res = await policy.execute(
      { provider: d.id, providerLabel: d.label, capability: step.capability, operation: step.operation },
      step.ask,
    );
    if (isOk(res)) {
      if (failures.length === 0) return res;
      // A fallback answered: worth counting by which provider took over from which.
      metrics.providerFallbacks.inc({ capability: step.capability, from: failures[0]!.provider, to: d.id });
      addSpanEvent('fallback', { capability: step.capability, from: failures[0]!.provider, to: d.id, failures: failures.length });
      const skipped = failures.map((f) => `${f.providerLabel}: ${f.message}`).join(' ');
      return { ...res, warnings: [...res.warnings, `${skipped} ${d.label} answered instead.`] };
    }
    failures.push(res);
    // A cancelled search stops here; trying another provider would spend its quota for nobody.
    if (res.local && res.status === 'timeout') break;
  }
  return combine(failures, steps[0]?.capability);
}

/** One failure standing for several: the first one's status (it was the preferred provider), everyone's account. */
function combine(failures: readonly ProviderFailure[], capability: ProviderCapability | undefined): ProviderFailure {
  const [first, ...rest] = failures;
  if (!first) {
    return fail('unavailable', 'none', 'No provider', 'No provider was available to ask.');
  }
  if (rest.length === 0) return first;
  return {
    ...first,
    ...(capability ? { capability } : {}),
    message: [first.message, ...rest.map((f) => `${f.providerLabel} was then tried and also failed: ${f.message}`)].join(' '),
  };
}

const ROUTING_CHAIN: ProviderDescriptor = {
  id: 'routing',
  label: 'Routing',
  kinds: ['routing'],
  requiredEnv: [],
  coverage: 'global',
  docsUrl: null,
  attribution: null,
};

/**
 * Several routing providers presented as one. Order is preference: the first is
 * asked first (Google's traffic-aware answer, when configured), and OSRM
 * answers when it cannot.
 */
export class FallbackRoutingProvider implements RoutingProvider {
  readonly descriptor: ProviderDescriptor;

  constructor(
    private readonly members: readonly RoutingProvider[],
    private readonly policy: ProviderPolicy,
  ) {
    this.descriptor = {
      ...ROUTING_CHAIN,
      label: `Routing (${members.map((m) => m.descriptor.label).join(', then ')})`,
      requiredEnv: members.flatMap((m) => m.descriptor.requiredEnv),
    };
  }

  isConfigured(): boolean {
    return this.members.some((m) => m.isConfigured());
  }

  /** Healthy if the preferred provider is; the others are reported by their own probes. */
  health() {
    return this.members[0]!.health();
  }

  route(req: RouteRequest): Promise<ProviderResult<RouteResult>> {
    return firstAnswer(
      this.policy,
      this.members
        .filter((m) => m.isConfigured())
        .map((provider) => ({
          provider,
          capability: 'routing' as const,
          operation: 'route',
          ask: () => provider.route(req),
        })),
    );
  }
}
