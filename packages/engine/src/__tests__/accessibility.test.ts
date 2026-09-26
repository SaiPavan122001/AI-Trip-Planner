import { describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@trip/providers';
import {
  buildConstraintsOnly,
  hotel,
  intent,
  profile,
  transportOffer,
} from './fixtures.js';
import {
  ok,
  zero,
  money,
  type AccessibilityNeed,
  type CostBreakdown,
  type HotelOffer,
  type ItineraryItem,
} from '@trip/shared';
import { unconfirmedHotelNeeds } from '../accessibility.js';
import { classifyJourney } from '../classify.js';
import { searchHotels } from '../hotels.js';
import { applyAnswer, nextQuestion } from '../questioner.js';
import { validateItinerary } from '../validate.js';

/**
 * Accessibility is a hard requirement from the question that asks about it
 * all the way to the validator. These tests follow it along that path.
 */

describe('asking about accessibility', () => {
  it('asks a solo traveller, not only families or larger groups', () => {
    const solo = intent({ travelers: { adults: 1, children: 0, infants: 0 } });
    const ctx = { intent: solo, classification: classifyJourney(solo.origin, solo.destination), profile: profile() };
    const keys: string[] = [];
    let current = ctx;
    for (let i = 0; i < 25; i += 1) {
      const q = nextQuestion(current);
      if (!q) break;
      keys.push(q.key);
      const answer = q.required
        ? { key: q.key, value: (q.kind === 'money' ? { amount: 5_000_000, currency: 'INR' } : q.kind === 'ranking' ? [q.options[0]!.value] : q.options[0]!.value) as never, skipped: false }
        : { key: q.key, value: null, skipped: true };
      current = { ...current, profile: applyAnswer(current, answer).profile };
    }
    expect(keys).toContain('traveler.accessibility');
  });

  it('offers every need the planner can represent', () => {
    const ctx = { intent: intent(), classification: classifyJourney(intent().origin, intent().destination), profile: profile({ answeredKeys: ['budget.total', 'style.travel_style', 'priorities.ranking', 'transport.mode_openness', 'transport.cabin_class', 'transport.baggage', 'transport.overnight', 'accommodation.type', 'accommodation.category', 'accommodation.rooms', 'accommodation.cancellation', 'accommodation.location', 'traveler.party_type'] }) };
    const q = nextQuestion(ctx);
    expect(q?.key).toBe('traveler.accessibility');
    expect(q?.options.map((o) => o.value).sort()).toEqual(
      [
        'accessible_bathroom',
        'elevator_required',
        'ground_floor_room',
        'hearing_assistance',
        'service_animal',
        'step_free_access',
        'visual_assistance',
        'wheelchair_accessible_room',
        'wheelchair_assistance_at_terminal',
      ].sort(),
    );
  });

  it('turns the answer into a hard constraint', () => {
    const ctx = { intent: intent(), classification: classifyJourney(intent().origin, intent().destination), profile: profile() };
    const { profile: answered } = applyAnswer(ctx, {
      key: 'traveler.accessibility',
      value: ['wheelchair_accessible_room'],
      skipped: false,
    });
    expect(buildConstraintsOnly(answered).hard).toContainEqual({
      kind: 'required_accessibility',
      value: ['wheelchair_accessible_room'],
    });
  });
});

describe('what counts as a hotel confirming a need', () => {
  const needs = (amenities: string[], wanted: AccessibilityNeed[]) =>
    unconfirmedHotelNeeds({ amenities }, wanted);

  it('accepts evidence for the need in provider formats', () => {
    expect(needs(['WHEELCHAIR_ACCESS'], ['wheelchair_accessible_room', 'step_free_access'])).toEqual([]);
    expect(needs(['Elevator'], ['elevator_required'])).toEqual([]);
    expect(needs(['ACCESSIBLE_BATHROOM'], ['accessible_bathroom'])).toEqual([]);
  });

  it('does not accept evidence for a different need', () => {
    // A lift is not step-free access; pets allowed is not a service-animal policy.
    expect(needs(['ELEVATOR'], ['step_free_access'])).toEqual(['step_free_access']);
    expect(needs(['PETS_ALLOWED'], ['service_animal'])).toEqual(['service_animal']);
    expect(needs(['WHEELCHAIR_ACCESS'], ['accessible_bathroom'])).toEqual(['accessible_bathroom']);
  });

  it('treats silence as unconfirmed', () => {
    expect(needs([], ['ground_floor_room'])).toEqual(['ground_floor_room']);
  });

  it('does not ask hotels about airport assistance', () => {
    expect(needs([], ['wheelchair_assistance_at_terminal'])).toEqual([]);
  });
});

describe('hotel search with an accessibility requirement', () => {
  const registryReturning = (hotels: HotelOffer[]) =>
    ({
      hotels: [{ searchHotels: async () => ok(hotels, hotels[0]!.provenance) }],
      missingCapabilityNote: () => {
        throw new Error('not expected');
      },
    }) as unknown as ProviderRegistry;

  const search = (hotels: HotelOffer[], needs: AccessibilityNeed[]) => {
    const p = profile({ special: { ...profile().special, accessibility: needs } });
    return searchHotels({
      registry: registryReturning(hotels),
      intent: intent(),
      profile: p,
      constraints: buildConstraintsOnly(p),
      activities: [],
      localTransportPerKm: null,
    });
  };

  it('keeps only properties that publish that they meet the need, and says why the rest went', async () => {
    const accessible = hotel({ id: 'h-accessible', amenities: ['WHEELCHAIR_ACCESS'] });
    const silent = hotel({ id: 'h-silent', amenities: ['WIFI'] });

    const result = await search([accessible, silent], ['wheelchair_accessible_room']);

    expect(result.candidates.map((c) => c.candidate.id)).toEqual(['h-accessible']);
    expect(result.filtered).toEqual([
      {
        hotelId: 'h-silent',
        reason: expect.stringMatching(/Does not publish that it offers a wheelchair-accessible room.*not a statement/),
      },
    ]);
  });

  it('explains honestly when accessibility removed every property', async () => {
    const result = await search([hotel({ id: 'h1', amenities: [] })], ['wheelchair_accessible_room']);

    expect(result.selected).toBeNull();
    const note = result.notes.find((n) => n.provider === 'engine');
    expect(note?.message).toMatch(/rarely publish accessibility details/);
    expect(note?.message).not.toMatch(/star rating/);
  });

  it('changes nothing when no accessibility need was stated', async () => {
    const result = await search([hotel({ id: 'h1', amenities: [] })], []);
    expect(result.candidates).toHaveLength(1);
  });
});

describe('validating a plan against accessibility needs', () => {
  const tripIntent = intent();
  const classification = classifyJourney(tripIntent.origin, tripIntent.destination);
  const z = zero('INR');
  const cost: CostBreakdown = {
    transport: z, transportFees: z, accommodation: z, localTransport: z, activities: z, meals: z, other: z,
    total: money(10_000, 'INR'), perPerson: money(5_000, 'INR'), estimatedPortion: z, remainingBudget: null, notIncluded: [],
  };
  const activity: ItineraryItem = {
    id: 'a1', kind: 'activity', title: 'Museum', description: null,
    startUtc: '2026-11-11T04:00:00.000Z', endUtc: '2026-11-11T05:00:00.000Z', timezone: 'Asia/Kolkata',
    locationName: null, cost: null, costIsEstimate: false, offerRef: null, notes: [],
  };

  const validate = (needs: AccessibilityNeed[], overrides: { amenities?: string[]; mode?: 'flight' | 'train' } = {}) => {
    const p = profile({ special: { ...profile().special, accessibility: needs } });
    const selected = hotel({ amenities: overrides.amenities ?? [] });
    return validateItinerary({
      intent: tripIntent,
      classification,
      profile: p,
      constraints: buildConstraintsOnly(p),
      items: [activity],
      cost,
      outbound: transportOffer({ mode: overrides.mode ?? 'flight' }),
      inbound: null,
      hotel: {
        hotel: selected, room: selected.rooms[0]!, rooms: 1, checkIn: '2026-11-10', checkOut: '2026-11-14',
        nights: 4, distanceToActivitiesKm: null, impliedDailyTransportCost: null,
      },
    });
  };

  it('blocks a plan whose hotel does not confirm a required need', () => {
    const issues = validate(['wheelchair_accessible_room']);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'accessibility_requirement_unmet', severity: 'blocker' }),
    );
  });

  it('does not block when the hotel confirms it', () => {
    const issues = validate(['wheelchair_accessible_room'], { amenities: ['WHEELCHAIR_ACCESS'] });
    expect(issues.map((i) => i.code)).not.toContain('accessibility_requirement_unmet');
  });

  it('says a train cannot be confirmed accessible rather than staying silent', () => {
    const issues = validate(['step_free_access'], { amenities: ['STEP_FREE_ACCESS'], mode: 'train' });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'transport_accessibility_unconfirmed', severity: 'warning' }),
    );
  });

  it('names the needs activity sources cannot check', () => {
    const issues = validate(['hearing_assistance'], { amenities: ['HEARING_LOOP'] });
    const warning = issues.find((i) => i.code === 'activity_accessibility_unconfirmed');
    expect(warning?.message).toMatch(/support for hearing impairment/);
  });

  it('adds nothing when no need was stated', () => {
    const codes = validate([]).map((i) => i.code);
    expect(codes.filter((c) => c.includes('accessib'))).toEqual([]);
  });
});
