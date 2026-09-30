import { passthroughPolicy, type BaseProvider, type ProviderRegistry } from '@trip/providers';
import {
  CAPABILITY_LABEL,
  isOk,
  noteFromFailure,
  noteFromWarning,
  statusClass,
  type ProviderCapability,
  type ProviderFailure,
  type ProviderNote,
  type ProviderResult,
  type ProviderStatusClass,
} from '@trip/shared';

/**
 * Asking every provider of one capability, safely.
 *
 * A search used to loop over providers one at a time, keep the last failure
 * and let anything a provider threw escape and end the whole run. This asks
 * all of them at once, each through the registry's policy (so a throw or a
 * hang becomes a failure), and hands back what answered *and* what did not:
 * one provider down is a note, not a lost search, and two providers failing in
 * two different ways are two notes.
 */

export interface ProviderSweep<T> {
  /** Everything the providers that answered returned, in provider order. */
  data: T[];
  /** One note for each provider that failed, and one for each warning from one that answered. */
  notes: ProviderNote[];
  failures: ProviderFailure[];
  /** How many providers answered successfully, even if with nothing. */
  answered: number;
  attempted: number;
}

export async function sweepProviders<P extends BaseProvider, T>(
  registry: ProviderRegistry,
  providers: readonly P[],
  capability: ProviderCapability,
  operation: string,
  call: (provider: P) => Promise<ProviderResult<T[]>>,
): Promise<ProviderSweep<T>> {
  const policy = registry.policy ?? passthroughPolicy;
  const results = await Promise.all(
    providers.map((provider) =>
      policy.execute(
        {
          provider: provider.descriptor?.id ?? capability,
          providerLabel: provider.descriptor?.label ?? CAPABILITY_LABEL[capability],
          capability,
          operation,
        },
        () => call(provider),
      ),
    ),
  );

  const sweep: ProviderSweep<T> = { data: [], notes: [], failures: [], answered: 0, attempted: providers.length };
  for (const res of results) {
    if (isOk(res)) {
      sweep.answered += 1;
      sweep.data.push(...res.data);
      for (const warning of res.warnings) sweep.notes.push(noteFromWarning(res.provenance, warning, capability));
    } else {
      sweep.failures.push(res);
      sweep.notes.push(noteFromFailure(res, capability));
    }
  }
  return sweep;
}

/**
 * The failure that best explains an empty result when several providers were
 * asked. A provider that broke says more than one that found nothing (the
 * search may be incomplete), so real trouble outranks "no results", which
 * outranks "not connected".
 */
const EXPLAINS_MOST: ProviderStatusClass[] = ['failed', 'timed_out', 'rate_limited', 'unusable', 'empty', 'not_available'];

export function primaryFailure(failures: readonly ProviderFailure[]): ProviderFailure | null {
  let best: ProviderFailure | null = null;
  let rank = Infinity;
  for (const f of failures) {
    const r = EXPLAINS_MOST.indexOf(statusClass(f.status));
    if (r < rank) {
      best = f;
      rank = r;
    }
  }
  return best;
}
