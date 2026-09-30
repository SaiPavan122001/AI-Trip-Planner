import { createHash } from 'node:crypto';
import type { PlanningSession } from '@trip/shared';

/**
 * JSON with object keys in a fixed order, so the same data always gives the
 * same text. PostgreSQL's JSONB does not keep key order, so hashing the
 * ordinary `JSON.stringify` of a trip would give a different answer before
 * and after it had been through the database.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Fingerprint of everything a search depends on. A run is created for one
 * fingerprint and its result is only saved if the trip still has it: if the
 * traveller changed the trip while the search ran, the plans it found are for
 * a trip that no longer exists and are thrown away, not shown.
 */
export function inputsHash(
  session: Pick<PlanningSession, 'intent' | 'profile' | 'constraints' | 'pins' | 'statedRequirements'>,
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        intent: session.intent,
        profile: session.profile,
        constraints: session.constraints,
        pins: [...session.pins].sort(),
        // What the traveller said in words steers the planning agents, so it is part of what a search depends on.
        requirements: session.statedRequirements,
      }),
    )
    .digest('hex');
}
