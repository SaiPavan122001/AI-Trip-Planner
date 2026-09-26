import { describe, expect, it } from 'vitest';
import { dedupeProviderNotes, money, statusClass, type TransportOffer } from '@trip/shared';
import { generatePlans } from '../plans.js';
import { classifyJourney } from '../classify.js';
import { searchTransport } from '../transport.js';
import { buildConstraintsOnly, hotel, intent, profile, transportOffer } from './fixtures.js';
import { activityProvider, answers, flightProvider, hotelProvider, never, railProvider, registryWith } from './kit.js';

/**
 * One provider having a bad day must not take the search with it.
 *
 * Every case here is a way a provider goes wrong that used to end the whole
 * run (a throw, a hang) or vanish from the explanation (only the last of
 * several failures was kept), and each must now leave the traveller with the
 * plans that could be built and a note for each thing that could not.
 */

const offer = (id: string, rupees = 9600): TransportOffer => ({ ...transportOffer(), id, totalPrice: money(rupees, 'INR') });

const flightsOk = () => flightProvider('flights', async () => answers.ok([offer('f1')]));
const hotelsOk = () => hotelProvider('hotels', async () => answers.ok([hotel()]));

const plan = (registry: ReturnType<typeof registryWith>) => {
  const p = profile();
  return generatePlans({ registry, intent: intent(), profile: p, constraints: buildConstraintsOnly(p) });
};

describe('a provider that breaks does not break the search', () => {
  it('survives a flight provider that throws, and reports it as unusable data', async () => {
    const registry = registryWith({
      flights: [
        flightProvider('flights', async () => {
          throw new TypeError("Cannot read properties of undefined (reading 'map')");
        }),
      ],
      hotels: [hotelsOk()],
    });
    const result = await plan(registry);

    expect(result.plans.length).toBeGreaterThan(0);
    const note = result.notes.find((n) => n.capability === 'flights' && n.provider === 'flights');
    expect(note).toMatchObject({ status: 'invalid_response' });
    expect(statusClass(note!.status)).toBe('unusable');
  });

  it('survives a hotel provider that throws, and still plans the journey', async () => {
    const registry = registryWith({
      flights: [flightsOk()],
      hotels: [
        hotelProvider('hotels', async () => {
          throw new Error('boom');
        }),
      ],
    });
    const result = await plan(registry);
    expect(result.plans.length).toBeGreaterThan(0);
    expect(result.plans[0]!.outboundTransport).not.toBeNull();
    expect(result.plans[0]!.hotels).toHaveLength(0);
    expect(result.notes.find((n) => n.capability === 'hotels')).toMatchObject({ provider: 'hotels', status: 'unavailable' });
  });

  it('survives an activity provider that throws', async () => {
    const registry = registryWith({
      flights: [flightsOk()],
      hotels: [hotelsOk()],
      activities: [
        activityProvider('places', async () => {
          throw new RangeError('bad coordinates');
        }),
      ],
    });
    const result = await plan(registry);
    expect(result.plans.length).toBeGreaterThan(0);
    expect(result.notes.find((n) => n.capability === 'activities')).toMatchObject({ status: 'invalid_response' });
  });

  it('gives up on a provider that never answers, at the deadline, and says it timed out', async () => {
    const registry = registryWith({
      deadlineMs: 60,
      flights: [flightProvider('slow-flights', never)],
      hotels: [hotelsOk()],
    });
    const started = Date.now();
    const result = await plan(registry);

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.notes.find((n) => n.provider === 'slow-flights')).toMatchObject({ status: 'timeout', capability: 'flights' });
    expect(statusClass('timeout')).toBe('timed_out');
  });
});

describe('several providers for one capability', () => {
  const trip = () => {
    const p = profile();
    return {
      intent: intent(),
      profile: p,
      constraints: buildConstraintsOnly(p),
      classification: classifyJourney(intent().origin, intent().destination),
    };
  };

  it('uses the ones that answered and reports the one that did not', async () => {
    const registry = registryWith({
      flights: [flightsOk(), flightProvider('limited', async () => answers.rateLimited('limited'))],
    });
    const result = await searchTransport({ registry, ...trip() }, 'outbound');
    const flight = result.modes.find((m) => m.mode === 'flight')!;

    expect(flight.offers).toHaveLength(1);
    // The mode has results, so it has no "why nothing" note; the traveller still hears about the provider that failed.
    expect(flight.note).toBeNull();
    expect(result.notes).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'limited', status: 'rate_limited', capability: 'flights' })]));
  });

  it('keeps every failure, not just the last one', async () => {
    const registry = registryWith({
      flights: [
        flightProvider('a', async () => answers.down('a')),
        flightProvider('b', async () => answers.unusable('b')),
        flightProvider('c', async () => answers.empty('c')),
      ],
    });
    const result = await searchTransport({ registry, ...trip() }, 'outbound');
    const flightNotes = result.notes.filter((n) => n.capability === 'flights');
    expect(flightNotes.map((n) => n.status).sort()).toEqual(['invalid_response', 'no_availability', 'unavailable']);
    // The one note given as the reason is the one that says most: a provider that broke, not one that found nothing.
    expect(result.modes.find((m) => m.mode === 'flight')!.note).toMatchObject({ provider: 'a', status: 'unavailable' });
  });

  it('asks its providers at the same time, not one after the other', async () => {
    const order: string[] = [];
    const slowThenNote = (id: string, ms: number) =>
      flightProvider(id, async () => {
        order.push(`start ${id}`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`end ${id}`);
        return answers.empty(id);
      });
    const registry = registryWith({ flights: [slowThenNote('a', 40), slowThenNote('b', 10)] });
    await searchTransport({ registry, ...trip() }, 'outbound');
    expect(order.slice(0, 2)).toEqual(['start a', 'start b']);
  });
});

describe('empty, failed, limited, timed out and not connected are five different answers', () => {
  const kinds: Array<[string, ReturnType<typeof flightProvider>, string, string]> = [
    ['empty', flightProvider('p', async () => answers.empty('p')), 'no_availability', 'empty'],
    ['failed', flightProvider('p', async () => answers.down('p')), 'unavailable', 'failed'],
    ['rate limited', flightProvider('p', async () => answers.rateLimited('p')), 'rate_limited', 'rate_limited'],
    ['timed out', flightProvider('p', never), 'timeout', 'timed_out'],
    ['unusable', flightProvider('p', async () => answers.unusable('p')), 'invalid_response', 'unusable'],
  ];

  it.each(kinds)('%s', async (_name, provider, status, cls) => {
    const registry = registryWith({ flights: [provider], deadlineMs: 50 });
    const p = profile();
    const result = await searchTransport(
      { registry, intent: intent(), profile: p, constraints: buildConstraintsOnly(p), classification: classifyJourney(intent().origin, intent().destination) },
      'outbound',
    );
    const note = result.modes.find((m) => m.mode === 'flight')!.note!;
    expect(note.status).toBe(status);
    expect(statusClass(note.status)).toBe(cls);
  });

  it('a deployment with no flight provider says "not connected", which is not any of those', async () => {
    const result = await plan(registryWith({ hotels: [hotelsOk()] }));
    expect(result.notes.find((n) => n.capability === 'flights')).toMatchObject({ status: 'not_configured' });
    expect(statusClass('not_configured')).toBe('not_available');
  });
});

describe('notes about different capabilities stay different notes', () => {
  it('reports missing flights and missing hotels as two notes, each about its own capability', async () => {
    const result = await plan(registryWith());
    // The outward and return searches each say it; a traveller is told once.
    const notes = dedupeProviderNotes(result.notes);
    const flights = notes.filter((n) => n.capability === 'flights');
    const hotels = notes.filter((n) => n.capability === 'hotels');
    expect(flights).toHaveLength(1);
    expect(hotels).toHaveLength(1);
    expect(flights[0]!.message).not.toEqual(hotels[0]!.message);
    expect(flights[0]!.message).toMatch(/flight/i);
    expect(hotels[0]!.message).toMatch(/hotel/i);
  });
});

describe('a mode that throws costs that mode and no more', () => {
  it('carries on with the others when the train provider throws', async () => {
    const registry = registryWith({
      flights: [flightsOk()],
      rail: [
        railProvider('rail', async () => {
          throw new Error('rail exploded');
        }, ['IN']),
      ],
    });
    const p = profile();
    const result = await searchTransport(
      { registry, intent: intent(), profile: p, constraints: buildConstraintsOnly(p), classification: classifyJourney(intent().origin, intent().destination) },
      'outbound',
    );
    expect(result.modes.find((m) => m.mode === 'flight')!.offers).toHaveLength(1);
    expect(result.modes.find((m) => m.mode === 'train')!.note).toMatchObject({ capability: 'trains', status: 'unavailable' });
  });
});
