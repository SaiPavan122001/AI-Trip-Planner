import { describe, expect, it } from 'vitest';
import { emptyTravelerProfile, fail } from '@trip/shared';
import { answers, busProvider, flightProvider } from './kit.js';
import { planTrip, surface } from './plan-kit.js';

/**
 * The ways of travelling the traveller chose are the only ones planned with.
 * When a chosen way cannot be searched, the plan says which and why, in that
 * source's own words; nothing the traveller ruled out is put in its place.
 */

const REFUSAL = "The Duffel token is not allowed to search flights: it lacks the 'air.offer_requests.create' permission.";
const refused = flightProvider('duffel', async () => fail('not_configured', 'duffel', 'Duffel (test mode)', REFUSAL));
const ALL = ['flight', 'train', 'bus', 'self_drive', 'rental_car', 'taxi', 'ferry'];

/** A trip where the traveller chose `modes`: flights are refused, a drive can be measured. */
function trip(modes: string[]) {
  const base = emptyTravelerProfile();
  return planTrip({
    parts: { flights: [refused], selfDrive: { distanceKm: 570, durationMinutes: 540 } },
    profile: { transport: { ...base.transport, excludedModes: ALL.filter((m) => !modes.includes(m)) as never } },
  });
}

describe('a journey whose departure point nobody states (an estimated bus fare)', () => {
  // Like the bus fare estimate: no stand, no code, no position for either end.
  const unstated = busProvider('bus-estimate', async (req: { date: string }) => {
    const offer = surface('bus', { id: 'bus-est', rupees: 1_500, departs: 8 * 60, minutes: 720 }, req.date);
    return answers.ok([
      {
        ...offer,
        segments: offer.segments.map((s) => ({
          ...s,
          operatorName: null,
          serviceNumber: null,
          origin: { ...s.origin, code: null, coordinates: null },
          destination: { ...s.destination, code: null, coordinates: null },
        })),
      },
    ]);
  });

  it('plans no transfer to a made-up stop, keeps every item possible, and says the stop is not known', async () => {
    const base = emptyTravelerProfile();
    const result = await planTrip({
      parts: { buses: [unstated] },
      profile: { transport: { ...base.transport, excludedModes: ALL.filter((m) => m !== 'bus') as never } },
    });
    const plan = result.plans[0]!;
    expect(plan.outboundTransport?.mode).toBe('bus');
    const items = plan.days.flatMap((d) => d.items);
    // No "travel to Hyderabad" from Hyderabad, at no distance, with a fare attached.
    expect(plan.transfers.filter((t) => t.from.name === t.to.name)).toHaveLength(0);
    expect(items.filter((i) => i.kind === 'transfer' && i.title.startsWith('Travel to'))).toHaveLength(0);
    expect(plan.issues.filter((i) => i.code === 'validation.item_duration')).toHaveLength(0);
    expect(items.some((i) => i.kind === 'buffer' && i.notes.some((n) => /leaves from is not stated/.test(n)))).toBe(true);
  });
});

describe('the ways of travelling the traveller chose', () => {
  it('never plans a way the traveller ruled out, even when it is the only one that works', async () => {
    const result = await trip(['flight', 'bus']);
    expect(result.plans.every((p) => p.outboundTransport?.mode !== 'self_drive')).toBe(true);
    expect(result.transport.outbound.modes.map((m) => m.mode).sort()).toEqual(['bus', 'flight']);
  });

  it("says why a chosen way could not be searched, in the source's own words, not \"no provider is connected\"", async () => {
    const result = await trip(['flight']);
    const findings = result.feasibility.findings.map((f) => f.message).join(' ');
    expect(findings).toContain(REFUSAL);
    expect(findings).not.toMatch(/no provider is connected for flights/);
  });

  it('plans with the chosen ways that work, and still reports the one that did not', async () => {
    const result = await trip(['flight', 'self_drive']);
    expect(result.plans.length).toBeGreaterThan(0);
    expect(result.plans.every((p) => p.outboundTransport?.mode === 'self_drive')).toBe(true);
    expect(result.notes.some((n) => n.capability === 'flights' && n.message === REFUSAL)).toBe(true);
  });
});
