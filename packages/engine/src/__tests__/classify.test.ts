import { describe, expect, it } from 'vitest';
import { classifyJourney } from '../classify.js';
import { bengaluru, hyderabad, london, paris } from './fixtures.js';

describe('journey classification', () => {
  it('treats a same-country journey as domestic and offers surface modes', () => {
    const result = classifyJourney(hyderabad, bengaluru);

    expect(result.scope).toBe('domestic');
    expect(result.eligibleModes).toContain('flight');
    expect(result.eligibleModes).toContain('train');
    expect(result.eligibleModes).toContain('bus');
    expect(result.crossesTimezones).toBe(false);
  });

  it('rules out surface travel between countries with no land link, with a reason', () => {
    const result = classifyJourney(hyderabad, paris);

    expect(result.scope).toBe('international');
    expect(result.eligibleModes).toContain('flight');
    expect(result.eligibleModes).not.toContain('train');
    expect(result.eligibleModes).not.toContain('bus');

    const train = result.excludedModes.find((m) => m.mode === 'train');
    // Every exclusion must be explainable to the traveller, not silent.
    expect(train?.reason).toMatch(/no practical surface route/i);
  });

  it('flags a timezone change so the itinerary can be rendered in local time', () => {
    const result = classifyJourney(hyderabad, paris);
    expect(result.crossesTimezones).toBe(true);
    expect(result.destinationTimezone).toBe('Europe/Paris');
    expect(result.documentationNotes.join(' ')).toMatch(/international journey/i);
  });

  it('keeps surface options open where a fixed link exists', () => {
    const result = classifyJourney(london, paris);
    expect(result.surfaceRoutePlausible).toBe(true);
    expect(result.eligibleModes).toContain('train');
  });

  it('drops flying for journeys too short to be worth the airport time', () => {
    const nearby = { ...bengaluru, coordinates: { lat: 17.45, lon: 78.55 } };
    const result = classifyJourney(hyderabad, nearby);

    expect(result.eligibleModes).not.toContain('flight');
    expect(result.excludedModes.find((m) => m.mode === 'flight')?.reason).toMatch(
      /airport time than it saves/i,
    );
  });

  it('excludes what the traveller ruled out, attributed to them', () => {
    const result = classifyJourney(hyderabad, bengaluru, { excludedByTraveler: ['bus'] });

    expect(result.eligibleModes).not.toContain('bus');
    expect(result.excludedModes.find((m) => m.mode === 'bus')?.reason).toMatch(/you asked/i);
  });
});
