import { describe, expect, it } from 'vitest';
import {
  LocalTime,
  money,
  zero,
  type ConstraintSet,
  type CostBreakdown,
  type TransportOffer,
  type TransportSegment,
} from '@trip/shared';
import { classifyJourney } from '../classify.js';
import { timeWindowViolations } from '../time-windows.js';
import { applyHardConstraints } from '../transport.js';
import { validateItinerary } from '../validate.js';
import { INDIA_LEG, intent, profile, transportOffer } from './fixtures.js';

/**
 * "Leave no earlier than" and "arrive no later than" are hard constraints,
 * read in local time where each departure and arrival happens.
 */

const windows = (
  earliest: string | null,
  latest: string | null,
  waived: Array<'earliest_departure_time' | 'latest_arrival_time'> = [],
): ConstraintSet => ({
  hard: [
    ...(earliest ? [{ kind: 'earliest_departure_time' as const, value: earliest }] : []),
    ...(latest ? [{ kind: 'latest_arrival_time' as const, value: latest }] : []),
  ],
  soft: [],
  budget: { total: null, transport: null, accommodation: null, dailySpend: null, activities: null, firm: false },
  waivers: waived.map((kind) => ({ kind, waivedAt: '2026-01-01T00:00:00.000Z', reason: 'test' })),
});

/** One-segment leg; timestamps exactly as a provider might give them. */
const leg = (departureAt: string, arrivalAt: string, timezones: [string | null, string | null] = [null, null]) => {
  const base = transportOffer().segments[0]!;
  const segment: TransportSegment = {
    ...base,
    departureAt,
    arrivalAt,
    origin: { ...base.origin, timezone: timezones[0] },
    destination: { ...base.destination, timezone: timezones[1] },
  };
  return transportOffer({ segments: [segment] });
};

// The fixture flight leaves Hyderabad at 08:00 and lands in Bengaluru at 09:15.
const hydToBlr = transportOffer();

describe('time windows on a domestic leg', () => {
  it('accepts a leg inside the window', () => {
    expect(timeWindowViolations(hydToBlr, windows('07:00', '22:00'), INDIA_LEG)).toEqual([]);
  });

  it('rejects a departure before the earliest time', () => {
    const v = timeWindowViolations(hydToBlr, windows('09:00', null), INDIA_LEG);
    expect(v).toEqual([
      { kind: 'earliest_departure_time', reason: expect.stringMatching(/Leaves at 08:00.*no earlier than 09:00/) },
    ]);
  });

  it('rejects an arrival after the latest time', () => {
    const v = timeWindowViolations(hydToBlr, windows(null, '09:00'), INDIA_LEG);
    expect(v).toEqual([
      { kind: 'latest_arrival_time', reason: expect.stringMatching(/Arrives at 09:15.*arrive by 09:00/) },
    ]);
  });

  it('includes the boundary minutes themselves', () => {
    expect(timeWindowViolations(hydToBlr, windows('08:00', '09:15'), INDIA_LEG)).toEqual([]);
  });

  it('does not accept an overnight arrival as "arriving by" a time the day before', () => {
    const overnight = leg('2026-11-10T22:00:00', '2026-11-11T06:00:00');
    const v = timeWindowViolations(overnight, windows(null, '22:00'), INDIA_LEG);
    expect(v[0]?.reason).toMatch(/Arrives on 2026-11-11 at 06:00.*after the day it leaves/);
  });

  it('is lifted only by an explicit waiver for that window', () => {
    expect(
      timeWindowViolations(hydToBlr, windows('09:00', '09:00', ['earliest_departure_time']), INDIA_LEG).map((v) => v.kind),
    ).toEqual(['latest_arrival_time']);
  });
});

describe('time windows across time zones', () => {
  it('reads the departure in the departure zone and the arrival in the arrival zone', () => {
    // Hyderabad 02:00 IST to Paris 08:30 CET. In IST the arrival would be
    // 13:00, which would wrongly break an "arrive by 09:00" rule.
    const flight = leg('2026-11-10T02:00:00+05:30', '2026-11-10T08:30:00+01:00');
    const zones = { departure: 'Asia/Kolkata', arrival: 'Europe/Paris' };
    expect(timeWindowViolations(flight, windows('01:30', '09:00'), zones)).toEqual([]);
    expect(timeWindowViolations(flight, windows(null, '08:00'), zones)[0]?.reason).toMatch(/Arrives at 08:30/);
  });

  it('reads a bare provider timestamp in the segment’s own zone', () => {
    // No offset: 21:30 is local time in Paris, as Amadeus reports it.
    const flight = leg('2026-11-10T14:00:00', '2026-11-10T21:30:00', ['Asia/Kolkata', 'Europe/Paris']);
    const zones = { departure: 'Asia/Kolkata', arrival: 'Asia/Kolkata' };
    expect(timeWindowViolations(flight, windows(null, '22:00'), zones)).toEqual([]);
    expect(timeWindowViolations(flight, windows(null, '21:00'), zones)[0]?.reason).toMatch(/Arrives at 21:30/);
  });

  it('uses the local clock on a daylight-saving day', () => {
    // New York jumps from 02:00 to 03:00 on 8 March 2026; this leg arrives
    // at 03:30 local time, one hour of wall clock after 01:30 plus the jump.
    const drive = leg('2026-03-08T01:30:00-05:00', '2026-03-08T03:30:00-04:00');
    const zones = { departure: 'America/New_York', arrival: 'America/New_York' };
    expect(timeWindowViolations(drive, windows('01:00', '04:00'), zones)).toEqual([]);
    expect(timeWindowViolations(drive, windows(null, '03:00'), zones)[0]?.reason).toMatch(/Arrives at 03:30/);
  });
});

describe('enforcement', () => {
  it('drops options outside the window before anything is ranked, saying why', () => {
    const early = transportOffer({ id: 'early' });
    const later = leg('2026-11-10T10:00:00', '2026-11-10T11:15:00');
    const { kept, dropped } = applyHardConstraints(
      [early, { ...later, id: 'later' }],
      windows('09:00', null),
      profile(),
      INDIA_LEG,
    );
    expect(kept.map((o) => o.id)).toEqual(['later']);
    expect(dropped).toEqual([{ offerId: 'early', reason: expect.stringMatching(/no earlier than 09:00/) }]);
  });

  it('has the validator block a plan whose return leg breaks the window', () => {
    const tripIntent = intent();
    const z = zero('INR');
    const cost: CostBreakdown = {
      transport: z, transportFees: z, accommodation: z, localTransport: z, activities: z, meals: z, other: z,
      total: money(10_000, 'INR'), perPerson: money(5_000, 'INR'), estimatedPortion: z, remainingBudget: null, notIncluded: [],
    };
    const lateReturn: TransportOffer = leg('2026-11-14T21:00:00', '2026-11-14T23:10:00');
    const issues = validateItinerary({
      intent: tripIntent,
      classification: classifyJourney(tripIntent.origin, tripIntent.destination),
      profile: profile(),
      constraints: windows(null, '22:00'),
      items: [],
      cost,
      outbound: hydToBlr,
      inbound: lateReturn,
      hotel: null,
    });
    const blocker = issues.find((i) => i.code === 'arrives_too_late');
    expect(blocker?.severity).toBe('blocker');
    expect(blocker?.message).toMatch(/return journey.*Arrives at 23:10/);
    expect(issues.map((i) => i.code)).not.toContain('departs_too_early');
  });
});

describe('the time format itself', () => {
  it.each(['9:00', '24:00', '12:60', '9am', '12:00:00'])('refuses %s', (value) => {
    expect(LocalTime.safeParse(value).success).toBe(false);
  });

  it.each(['00:00', '09:05', '23:59'])('accepts %s', (value) => {
    expect(LocalTime.safeParse(value).success).toBe(true);
  });
});
