import { describe, expect, it } from 'vitest';
import type { ModificationRequest } from '@trip/shared';
import { applyModification } from '../modify.js';
import { buildConstraintsOnly, intent, profile } from './fixtures.js';

const request = (overrides: Partial<ModificationRequest>): ModificationRequest => ({
  utterance: 'test',
  intent: 'unknown',
  parameters: {},
  affectedComponents: [],
  pinnedComponents: [],
  requiresWaiver: [],
  ...overrides,
});

describe('the engine boundary for modifications', () => {
  it('refuses unvalidated parameters even when a caller skipped validation', () => {
    const p = profile();
    const unvalidated = request({
      intent: 'shift_departure_time',
      parameters: { earliestDeparture: '9am' } as never,
    });
    expect(() => applyModification(unvalidated, intent(), p, buildConstraintsOnly(p))).toThrow();
    // The profile passed in is untouched.
    expect(p.transport.earliestDepartureLocal).toBeNull();
  });

  it('refuses a priority that does not exist', () => {
    const p = profile();
    const unvalidated = request({ intent: 'reprioritise', parameters: { priorities: ['bribery'] } as never });
    expect(() => applyModification(unvalidated, intent(), p, buildConstraintsOnly(p))).toThrow();
  });
});
