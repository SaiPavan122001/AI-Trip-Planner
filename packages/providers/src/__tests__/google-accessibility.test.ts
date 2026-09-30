import { describe, expect, it } from 'vitest';
import { matchesAccessibility } from '../adapters/google-maps.js';

/**
 * Google publishes separate wheelchair fields for parking, entrance, restroom
 * and seating. Each need must be matched to its own field: an accessible car
 * park says nothing about whether the entrance is step-free.
 */
describe('matching places to accessibility needs', () => {
  const place = (accessibility: string[]) => ({ accessibility });

  it('requires an accessible entrance for step-free access', () => {
    expect(matchesAccessibility(place(['wheelchairAccessibleEntrance']), ['step_free_access'])).toBe(true);
    expect(matchesAccessibility(place(['wheelchairAccessibleParking']), ['step_free_access'])).toBe(false);
  });

  it('requires an accessible restroom for an accessible bathroom', () => {
    expect(matchesAccessibility(place(['wheelchairAccessibleEntrance']), ['accessible_bathroom'])).toBe(false);
    expect(
      matchesAccessibility(place(['wheelchairAccessibleRestroom']), ['accessible_bathroom']),
    ).toBe(true);
  });

  it('requires every stated need, not just one', () => {
    expect(
      matchesAccessibility(place(['wheelchairAccessibleEntrance']), ['step_free_access', 'accessible_bathroom']),
    ).toBe(false);
  });

  it('does not filter on needs Google publishes nothing about', () => {
    // These are reported on the plan by the validator instead.
    expect(matchesAccessibility(place([]), ['hearing_assistance', 'service_animal'])).toBe(true);
  });
});
