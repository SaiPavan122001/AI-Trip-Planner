import { describe, expect, it } from 'vitest';
import { money } from '@trip/shared';
import { scoreTransportOffers } from '../scoring.js';
import { profile, transportOffer } from './fixtures.js';

const flight = transportOffer({
  id: 'flight',
  mode: 'flight',
  totalPrice: money(9600, 'INR'),
  totalDurationMinutes: 75,
  transfers: 0,
});

const train = transportOffer({
  id: 'train',
  mode: 'train',
  totalPrice: money(3700, 'INR'),
  totalDurationMinutes: 500,
  transfers: 0,
});

const bus = transportOffer({
  id: 'bus',
  mode: 'bus',
  totalPrice: money(2400, 'INR'),
  totalDurationMinutes: 600,
  transfers: 0,
});

describe('priority scoring', () => {
  it('puts the cheapest option first when price leads the ranking', () => {
    const ranked = scoreTransportOffers([flight, train, bus], profile({ priorities: ['cheapest'] }));
    expect(ranked[0]?.candidate.id).toBe('bus');
  });

  it('puts the quickest option first when time leads the ranking', () => {
    const ranked = scoreTransportOffers([flight, train, bus], profile({ priorities: ['fastest'] }));
    expect(ranked[0]?.candidate.id).toBe('flight');
  });

  it('changes the answer when the ranking changes, not just the wording', () => {
    const cheap = scoreTransportOffers([flight, train, bus], profile({ priorities: ['cheapest'] }));
    const fast = scoreTransportOffers([flight, train, bus], profile({ priorities: ['fastest'] }));
    expect(cheap[0]?.candidate.id).not.toBe(fast[0]?.candidate.id);
  });

  it('lets a secondary priority break what the first one leaves close', () => {
    const nearlyIdentical = [
      transportOffer({ id: 'direct', totalPrice: money(9600, 'INR'), transfers: 0 }),
      transportOffer({ id: 'one-stop', totalPrice: money(9500, 'INR'), transfers: 1 }),
    ];
    const ranked = scoreTransportOffers(
      nearlyIdentical,
      profile({ priorities: ['fewest_transfers', 'cheapest'] }),
    );
    expect(ranked[0]?.candidate.id).toBe('direct');
  });

  it('penalises an overnight leg the traveller asked to avoid', () => {
    const day = transportOffer({ id: 'day', overnight: false });
    const night = transportOffer({ id: 'night', overnight: true });

    const avoiding = profile({ priorities: ['cheapest'] });
    avoiding.transport.avoidOvernightTravel = true;

    const [dayScore] = scoreTransportOffers([day], avoiding);
    const [nightScore] = scoreTransportOffers([night], avoiding);

    // Scoring only ranks; the hard filter in applyHardConstraints is what
    // actually removes an overnight leg the traveller ruled out.
    expect(nightScore!.score).toBeLessThan(dayScore!.score);
    expect(nightScore!.breakdown['overnight_penalty']).toBeDefined();
  });

  it('explains every ranking with a per-priority breakdown', () => {
    const ranked = scoreTransportOffers(
      [flight, train],
      profile({ priorities: ['cheapest', 'fastest'] }),
    );
    expect(Object.keys(ranked[0]!.breakdown)).toEqual(
      expect.arrayContaining(['cheapest', 'fastest']),
    );
  });

  it('returns a neutral score rather than failing when nothing was ranked', () => {
    const ranked = scoreTransportOffers([flight], profile({ priorities: [] }));
    expect(ranked[0]?.score).toBeGreaterThan(0);
  });
});
