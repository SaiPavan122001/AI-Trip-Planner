import { describe, expect, it } from 'vitest';
import { PlanningSession, emptyConstraintSet, emptyTravelerProfile } from '../index.js';
import { ACTIVE_RUN_STATUSES, PlanningRunView, isActiveRun } from '../runs.js';

/**
 * Trips are stored as documents, and a document written before a field
 * existed must still be readable: one unreadable row is a traveller's trip
 * gone. New fields therefore always carry a default.
 */

const place = {
  id: 'p',
  name: 'Hyderabad',
  displayName: 'Hyderabad, India',
  coordinates: { lat: 17.385, lon: 78.4867 },
  countryCode: 'IN',
  countryName: 'India',
  timezone: 'Asia/Kolkata',
  airports: [],
  source: 'test',
  resolvedAt: '2026-01-01T00:00:00.000Z',
};

const stored = {
  id: 'abc',
  ownerId: null,
  stage: 'planned',
  intent: {
    originQuery: 'a',
    destinationQuery: 'b',
    departureDate: '2030-11-10',
    returnDate: null,
    travelers: { adults: 1, children: 0, infants: 0 },
    currency: 'INR',
    origin: place,
    destination: { ...place, id: 'q', name: 'Bengaluru' },
  },
  classification: {
    scope: 'domestic',
    originCountry: 'IN',
    destinationCountry: 'IN',
    greatCircleKm: 500,
    crossesTimezones: false,
    originTimezone: 'Asia/Kolkata',
    destinationTimezone: 'Asia/Kolkata',
    surfaceRoutePlausible: true,
    eligibleModes: ['flight'],
    excludedModes: [],
    documentationNotes: [],
  },
  profile: emptyTravelerProfile(),
  constraints: emptyConstraintSet(),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('a trip stored before versions, pins and search summaries existed', () => {
  it('still reads, with those fields defaulted', () => {
    const trip = PlanningSession.parse(stored);
    expect(trip.version).toBe(0);
    expect(trip.pins).toEqual([]);
    expect(trip.lastSearch).toBeNull();
  });

  it('rejects a pin for a part that does not exist', () => {
    expect(PlanningSession.safeParse({ ...stored, pins: ['spaceship'] }).success).toBe(false);
    expect(PlanningSession.parse({ ...stored, pins: ['hotel', 'outbound'] }).pins).toEqual(['hotel', 'outbound']);
  });

  it('keeps a search summary as it was produced', () => {
    const summary = {
      builtAt: '2026-01-01T00:00:00.000Z',
      outbound: { date: '2030-11-10', modes: [{ mode: 'flight', allOffers: [] }] },
      inbound: null,
      hotelsConsidered: 2,
      hotelsFiltered: [{ hotelId: 'h', reason: 'too dear' }],
      budgetConflict: null,
      feasibility: null,
    };
    expect(PlanningSession.parse({ ...stored, lastSearch: summary }).lastSearch).toEqual(summary);
  });

  it('reads a search summary saved before feasibility reports existed', () => {
    const older = { builtAt: '2026-01-01T00:00:00.000Z', outbound: null, inbound: null, hotelsConsidered: 0, hotelsFiltered: [], budgetConflict: null };
    const read = PlanningSession.parse({ ...stored, lastSearch: older });
    expect(read.lastSearch?.feasibility).toBeNull();
  });

  it('reads a provider note saved before notes named their capability', () => {
    const note = { provider: 'amadeus', providerLabel: 'Amadeus', status: 'not_configured', message: 'x', occurredAt: '2026-01-01T00:00:00.000Z' };
    expect(PlanningSession.parse({ ...stored, providerNotes: [note] }).providerNotes[0]!.capability).toBeUndefined();
  });
});

describe('planning runs', () => {
  it('knows which states are still going', () => {
    expect(ACTIVE_RUN_STATUSES).toEqual(['queued', 'running']);
    expect(isActiveRun('queued')).toBe(true);
    expect(isActiveRun('running')).toBe(true);
    for (const done of ['succeeded', 'failed', 'cancelled', 'superseded'] as const) {
      expect(isActiveRun(done)).toBe(false);
    }
  });

  it('describes a run to a client without anything internal', () => {
    const view = PlanningRunView.parse({
      id: '11111111-1111-4111-8111-111111111111',
      tripId: '22222222-2222-4222-8222-222222222222',
      kind: 'plan',
      status: 'running',
      progress: { step: 'search', label: 'Searching', percent: 15 },
      error: null,
      cancelRequested: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      // Fields a store keeps but a client must never see.
      workerId: 'w',
      inputsHash: 'x',
      params: { keep: {} },
    });
    expect(Object.keys(view)).not.toContain('workerId');
    expect(Object.keys(view)).not.toContain('params');
    expect(PlanningRunView.safeParse({ ...view, progress: { step: 's', label: 'l', percent: 101 } }).success).toBe(false);
  });
});
