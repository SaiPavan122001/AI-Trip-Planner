import type { ProviderCapability, ProviderFailure, ProviderProvenance } from './provider-result.js';
import type { ProviderNote } from './session.js';

/**
 * Provider notes: what a traveller is told about a source that failed, was
 * missing, or had something to say. One place builds and merges them, so a
 * note always names the capability it is about.
 */

/** A failed provider call as a note. */
export function noteFromFailure(
  failure: Pick<ProviderFailure, 'status' | 'provider' | 'providerLabel' | 'message' | 'occurredAt'> & {
    capability?: ProviderCapability | undefined;
  },
  capability?: ProviderCapability,
): ProviderNote {
  const cap = failure.capability ?? capability;
  return {
    provider: failure.provider,
    providerLabel: failure.providerLabel,
    ...(cap ? { capability: cap } : {}),
    status: failure.status,
    message: failure.message,
    occurredAt: failure.occurredAt,
  };
}

/** A warning from a successful provider call as a note. */
export function noteFromWarning(
  provenance: Pick<ProviderProvenance, 'provider' | 'providerLabel' | 'retrievedAt'>,
  message: string,
  capability?: ProviderCapability,
): ProviderNote {
  return {
    provider: provenance.provider,
    providerLabel: provenance.providerLabel,
    ...(capability ? { capability } : {}),
    status: 'ok',
    message,
    occurredAt: provenance.retrievedAt,
  };
}

/** A note from the planner itself rather than from a provider. */
export function plannerNote(
  message: string,
  status = 'ok',
  capability: ProviderCapability = 'planner',
): ProviderNote {
  return {
    provider: 'engine',
    providerLabel: 'Planner',
    capability,
    status,
    message,
    occurredAt: new Date().toISOString(),
  };
}

/**
 * Notes repeat across searches; a traveller needs each once. Two notes are the
 * same only if they agree on the source, the capability, the outcome and the
 * words: Flights and Hotels from one vendor are different notes even when
 * the vendor and the outcome are the same, because they are about different
 * parts of the trip. The latest occurrence wins.
 */
export function dedupeProviderNotes(notes: ProviderNote[]): ProviderNote[] {
  const seen = new Map<string, ProviderNote>();
  for (const note of notes) {
    seen.set(`${note.provider}|${note.capability ?? ''}|${note.status}|${note.message}`, note);
  }
  return [...seen.values()];
}
