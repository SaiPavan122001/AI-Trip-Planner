import { describe, expect, it } from 'vitest';
import type { RequirementsState } from '@trip/shared';
import {
  applyGuidance,
  noGuidance,
  runAccommodationAgent,
  runActivityAgent,
  runRequirementsAgent,
  runTransportAgent,
  statedFrom,
} from '../index.js';
import { TODAY, fakeLlm, noModel, profile } from './kit.js';

/**
 * The Transport, Accommodation and Activity agents: bounded guidance, grounded
 * in what the traveller said, and unable to touch a price, a schedule, a hard
 * constraint or an answer the traveller already gave.
 */

async function stated(message: string): Promise<RequirementsState> {
  const outcome = await runRequirementsAgent({ message, today: TODAY }, { llm: noModel() });
  if (!outcome.ok) throw new Error('requirements failed');
  return outcome.data;
}

const MODES = ['flight', 'train', 'bus', 'self_drive'] as const;
const transportInput = (overrides = {}) => ({
  scope: 'domestic' as const,
  eligibleModes: [...MODES],
  excludedModes: [] as never[],
  requiredMode: null,
  currentPreferredMode: null,
  stated: statedFrom(null),
  ...overrides,
});

describe('Transport Agent', () => {
  it('consults every mode the journey allows, minus the ones ruled out', async () => {
    const outcome = await runTransportAgent(transportInput({ excludedModes: ['bus'] }), { llm: noModel() });
    expect(outcome.ok && outcome.data.consult).toEqual(['flight', 'train', 'self_drive']);
  });

  it('favours the mode the traveller said they like, and only that', async () => {
    const requirements = await stated('from Pune to Goa on 12 December for 2 people, we prefer to go by train');
    const outcome = await runTransportAgent(transportInput({ stated: statedFrom(requirements) }), { llm: noModel() });
    expect(outcome.ok && outcome.data.preferredMode).toBe('train');
    expect(outcome.ok && outcome.data.modeOrder[0]).toBe('train');
    // The others are still consulted: a preference is not an exclusion.
    expect(outcome.ok && outcome.data.consult).toEqual(['flight', 'train', 'bus', 'self_drive']);
  });

  it('says plainly when the journey cannot be made the way the traveller insisted, without asking a model', async () => {
    const { llm, calls } = fakeLlm(() => ({}));
    const outcome = await runTransportAgent(
      transportInput({ eligibleModes: ['flight'], requiredMode: 'train' }),
      { llm },
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: 'impossible' } });
    expect(!outcome.ok && outcome.error.message).toMatch(/only by train.*not possible for this journey/);
    expect(calls).toHaveLength(0);
  });

  it('says so when everything has been ruled out', async () => {
    const outcome = await runTransportAgent(transportInput({ eligibleModes: ['flight'], excludedModes: ['flight'] }), { llm: noModel() });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'impossible' } });
  });

  it('narrows to the required mode when it is possible', async () => {
    const outcome = await runTransportAgent(transportInput({ requiredMode: 'train' }), { llm: noModel() });
    expect(outcome.ok && outcome.data.consult).toEqual(['train']);
  });

  it('cannot bring back a mode the journey does not allow, or one nobody asked for', async () => {
    const requirements = await stated('from Pune to Goa on 12 December for 2 people, by bus is fine');
    const { llm } = fakeLlm(() => ({ preferredMode: 'ferry', modeOrder: ['ferry', 'bus', 'flight'], reasons: [] }));
    const outcome = await runTransportAgent(transportInput({ stated: statedFrom(requirements) }), { llm });
    expect(outcome.ok && outcome.data.preferredMode).toBeNull();
    expect(outcome.ok && outcome.data.consult).not.toContain('ferry');
    expect(outcome.ok && outcome.data.modeOrder).not.toContain('ferry');
    expect(outcome.meta.rejected.join(' ')).toMatch(/not among the modes/);
  });

  it('will not favour a mode the traveller said nothing about', async () => {
    const { llm } = fakeLlm(() => ({ preferredMode: 'flight', modeOrder: [], reasons: [] }));
    const outcome = await runTransportAgent(transportInput(), { llm });
    expect(outcome.ok && outcome.data.preferredMode).toBeNull();
    expect(outcome.meta.rejected.join(' ')).toMatch(/did not say anything that favours it/);
  });

  it('never overrides a preference already on the trip', async () => {
    const requirements = await stated('from Pune to Goa on 12 December for 2 people, we prefer to go by train');
    const outcome = await runTransportAgent(
      transportInput({ stated: statedFrom(requirements), currentPreferredMode: 'bus' }),
      { llm: noModel() },
    );
    expect(outcome.ok && outcome.data.preferredMode).toBeNull();
  });

  it('keeps figures out of the reasons it records', async () => {
    const requirements = await stated('from Pune to Goa on 12 December for 2 people, by train please');
    const { llm } = fakeLlm(() => ({
      preferredMode: 'train',
      modeOrder: ['train'],
      reasons: ['A train saves about ₹2,000 and 3 hours', 'It suits what was said', 'See https://evil.example'],
    }));
    const outcome = await runTransportAgent(transportInput({ stated: statedFrom(requirements) }), { llm });
    expect(outcome.ok && outcome.data.reasons).toEqual(['It suits what was said']);
    expect(outcome.meta.rejected.length).toBeGreaterThan(0);
  });

  it('carries no price, schedule or duration: its output has no such field', async () => {
    const requirements = await stated('from Pune to Goa on 12 December for 2 people, by train please');
    const { llm } = fakeLlm(() => ({ preferredMode: 'train', modeOrder: [], reasons: [], price: 1, durationMinutes: 5, fare: 0 }));
    const outcome = await runTransportAgent(transportInput({ stated: statedFrom(requirements) }), { llm });
    expect(outcome.ok && Object.keys(outcome.data).sort()).toEqual(['consult', 'modeOrder', 'preferredMode', 'reasons']);
  });

  it('degrades to the rules when the model is down', async () => {
    const requirements = await stated('from Pune to Goa on 12 December for 2 people, by train please');
    const outcome = await runTransportAgent(transportInput({ stated: statedFrom(requirements) }), { llm: fakeLlm(() => new Error('down')).llm });
    expect(outcome.ok && outcome.meta.source).toBe('rules');
    expect(outcome.ok && outcome.data.preferredMode).toBe('train');
  });

  it('stops when the search is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const requirements = await stated('from Pune to Goa on 12 December for 2 people, by train please');
    const outcome = await runTransportAgent(transportInput({ stated: statedFrom(requirements) }), { llm: noModel(), signal: controller.signal });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'aborted' } });
  });
});

describe('Accommodation Agent', () => {
  it('reads stay preferences from what the traveller said', async () => {
    const requirements = await stated('from Pune to Goa on 12 December for 2 people, a quiet place with breakfast and a pool');
    const outcome = await runAccommodationAgent(
      { nights: 3, travelers: { adults: 2, children: 0, infants: 0 }, stated: statedFrom(requirements) },
      { llm: noModel() },
    );
    expect(outcome.ok && outcome.data.breakfast).toBe(true);
    expect(outcome.ok && outcome.data.amenities).toEqual(['breakfast', 'pool']);
  });

  it('drops an amenity or area the traveller never asked for', async () => {
    const requirements = await stated('from Pune to Goa on 12 December for 2 people, we like breakfast');
    const { llm } = fakeLlm(() => ({ area: 'central', amenities: ['breakfast', 'spa', 'gym'], reasons: [] }));
    const outcome = await runAccommodationAgent(
      { nights: 3, travelers: { adults: 2, children: 0, infants: 0 }, stated: statedFrom(requirements) },
      { llm },
    );
    expect(outcome.ok && outcome.data.amenities).toEqual(['breakfast']);
    expect(outcome.ok && outcome.data.area).toBeNull();
    expect(outcome.meta.rejected.join(' ')).toMatch(/did not ask for it/);
  });

  it('does nothing, and asks no model, for a trip with no night away', async () => {
    const { llm, calls } = fakeLlm(() => ({}));
    const requirements = await stated('from Pune to Goa on 12 December for 2 people, with breakfast');
    const outcome = await runAccommodationAgent(
      { nights: 0, travelers: { adults: 2, children: 0, infants: 0 }, stated: statedFrom(requirements) },
      { llm },
    );
    expect(outcome.ok && outcome.data).toEqual({ area: null, breakfast: false, amenities: [], reasons: [] });
    expect(calls).toHaveLength(0);
  });

  it('has no way to set a room count or a price', async () => {
    const requirements = await stated('from Pune to Goa on 12 December for 2 people, with breakfast');
    const { llm } = fakeLlm(() => ({ area: null, amenities: ['breakfast'], reasons: [], rooms: 9, pricePerNight: 1 }));
    const outcome = await runAccommodationAgent(
      { nights: 3, travelers: { adults: 2, children: 0, infants: 0 }, stated: statedFrom(requirements) },
      { llm },
    );
    expect(outcome.ok && Object.keys(outcome.data).sort()).toEqual(['amenities', 'area', 'breakfast', 'reasons']);
  });
});

describe('Activity Agent', () => {
  it('reads interests and pace from what the traveller said', async () => {
    const requirements = await stated('from Pune to Goa on 12 December for 2 people, we like beaches and history at a relaxed pace');
    const outcome = await runActivityAgent({ days: 3, stated: statedFrom(requirements) }, { llm: noModel() });
    expect(outcome.ok && outcome.data.interests).toEqual(['history', 'beaches']);
    expect(outcome.ok && outcome.data.pace).toBe('relaxed');
  });

  it('drops interests nobody expressed, and names no place', async () => {
    const requirements = await stated('from Pune to Goa on 12 December for 2 people, we like beaches');
    const { llm } = fakeLlm(() => ({ interests: ['beaches', 'nightlife', 'shopping'], pace: 'packed', reasons: [] }));
    const outcome = await runActivityAgent({ days: 3, stated: statedFrom(requirements) }, { llm });
    expect(outcome.ok && outcome.data.interests).toEqual(['beaches']);
    expect(outcome.ok && outcome.data.pace).toBeNull();
    expect(outcome.ok && Object.keys(outcome.data).sort()).toEqual(['interests', 'pace', 'reasons']);
  });

  it('does nothing when there are no free days or nothing was said', async () => {
    const { llm, calls } = fakeLlm(() => ({}));
    expect((await runActivityAgent({ days: 0, stated: statedFrom(null) }, { llm })).ok).toBe(true);
    expect((await runActivityAgent({ days: 3, stated: statedFrom(null) }, { llm })).ok).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('applying guidance', () => {
  const guidance = () => ({
    ...noGuidance(),
    transport: { consult: ['flight', 'train'] as never, preferredMode: 'train' as const, modeOrder: [], reasons: [] },
    accommodation: { area: 'quiet' as const, breakfast: true, amenities: ['breakfast', 'pool'] as never, reasons: [] },
    activities: { interests: ['beaches' as const], pace: 'relaxed' as const, reasons: [] },
  });

  it('fills what the traveller left empty', () => {
    const result = applyGuidance(profile(), guidance());
    expect(result.profile.transport.preferredMode).toBe('train');
    expect(result.profile.accommodation.locationPreference).toBe('in a quiet area');
    expect(result.profile.accommodation.breakfastIncluded).toBe(true);
    expect(result.activityGuidance).toEqual({ interests: ['beaches'], pace: 'relaxed' });
    expect(result.notApplied.join(' ')).toMatch(/pool: noted, but nothing here scores or filters on it yet/);
  });

  it('never overwrites what the traveller already answered', () => {
    const p = profile();
    p.transport.preferredMode = 'bus';
    p.accommodation.locationPreference = 'near the old town';
    p.accommodation.breakfastIncluded = false;
    const result = applyGuidance(p, guidance());
    expect(result.profile.transport.preferredMode).toBe('bus');
    expect(result.profile.accommodation.locationPreference).toBe('near the old town');
    expect(result.profile.accommodation.breakfastIncluded).toBe(false);
    expect(result.notApplied).toHaveLength(4);
  });

  it('touches nothing hard, and does not change the profile it was given', () => {
    const p = profile();
    p.transport.excludedModes = ['bus'];
    p.accommodation.minCategory = 4;
    p.accommodation.rooms = 2;
    p.priorities = ['cheapest'];
    p.special.accessibility = ['step_free_access'];
    const before = structuredClone(p);
    const result = applyGuidance(p, guidance());
    expect(p).toEqual(before);
    for (const key of ['excludedModes', 'earliestDepartureLocal', 'latestArrivalLocal', 'maxStops'] as const) {
      expect(result.profile.transport[key]).toEqual(p.transport[key]);
    }
    expect(result.profile.accommodation.minCategory).toBe(4);
    expect(result.profile.accommodation.rooms).toBe(2);
    expect(result.profile.priorities).toEqual(['cheapest']);
    expect(result.profile.special.accessibility).toEqual(['step_free_access']);
    expect(result.profile.accommodation.freeCancellationRequired).toBe(p.accommodation.freeCancellationRequired);
  });

  it('is a no-op with no guidance', () => {
    const p = profile();
    const result = applyGuidance(p, noGuidance());
    expect(result.profile).toEqual(p);
    expect(result.applied).toEqual([]);
    expect(result.activityGuidance).toEqual({});
  });
});
