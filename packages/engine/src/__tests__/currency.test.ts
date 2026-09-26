import { describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@trip/providers';
import {
  TripIntentInput,
  money,
  ok,
  type JourneyClassification,
  type TransportOffer,
} from '@trip/shared';
import { keepSupportedHotels, keepSupportedTransport, supportedPriceOrUnknown } from '../currency.js';
import { applyHardConstraints, searchTransport } from '../transport.js';
import { buildConstraintsOnly, hotel, intent, profile, transportOffer } from './fixtures.js';

/**
 * INR is the only supported currency. Anything else must never be compared
 * with rupees (which used to crash), never slip past a budget check (which
 * used to happen silently), and never be converted at an invented rate.
 */

const inEuros = (overrides: Partial<TransportOffer> = {}) =>
  transportOffer({
    id: 'eur-offer',
    totalPrice: money(80, 'EUR'),
    pricePerTraveler: money(40, 'EUR'),
    fareClasses: [],
    provenance: { ...transportOffer().provenance, provider: 'rail', providerLabel: 'Rail provider' },
    ...overrides,
  });

describe('the currency boundary', () => {
  it('sets aside transport priced in another currency and says which provider', () => {
    const { kept, notes } = keepSupportedTransport([transportOffer(), inEuros()]);

    expect(kept.map((o) => o.id)).toEqual(['test-offer']);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toMatch(/Rail provider returned options priced in EUR/);
    expect(notes[0]!.message).toMatch(/does not convert currencies/);
  });

  it('catches a foreign amount hidden in a fee, not only in the total', () => {
    const sneaky = transportOffer({
      id: 'mixed',
      itemisedFees: [{ label: 'Service fee', amount: money(5, 'USD'), included: false, isEstimate: false, basis: null }],
    });
    expect(keepSupportedTransport([sneaky]).kept).toEqual([]);
  });

  it('keeps a hotel with some rupee rates, dropping only the foreign ones', () => {
    const base = hotel();
    const mixed = hotel({
      rooms: [
        base.rooms[0]!,
        { ...base.rooms[0]!, id: 'room-eur', totalPrice: money(300, 'EUR'), pricePerNight: money(75, 'EUR') },
      ],
    });
    const { kept, notes } = keepSupportedHotels([mixed]);

    expect(kept[0]!.rooms.map((r) => r.id)).toEqual(['room-1']);
    expect(notes[0]!.message).toMatch(/EUR/);
  });

  it('sets aside a hotel with no rupee rates at all', () => {
    const base = hotel();
    const foreign = hotel({ rooms: [{ ...base.rooms[0]!, totalPrice: money(300, 'EUR'), pricePerNight: money(75, 'EUR') }] });
    expect(keepSupportedHotels([foreign]).kept).toEqual([]);
  });

  it('turns a foreign transfer or entry price into unknown, never into zero', () => {
    const result = supportedPriceOrUnknown(money(12, 'EUR'), transportOffer().provenance);
    expect(result.price).toBeNull();
    expect(result.note?.message).toMatch(/shown as unknown/);

    expect(supportedPriceOrUnknown(money(500, 'INR'), transportOffer().provenance).price).toEqual(money(500, 'INR'));
    expect(supportedPriceOrUnknown(null, transportOffer().provenance)).toEqual({ price: null, note: null });
  });
});

describe('budgets are never skipped because of currency', () => {
  it('drops an offer whose currency cannot be checked against the budget', () => {
    const p = profile();
    const constraints = {
      ...buildConstraintsOnly(p),
      budget: { total: null, transport: money(5000, 'INR'), accommodation: null, dailySpend: null, activities: null },
    };
    const { kept, dropped } = applyHardConstraints([inEuros()], constraints, p);

    expect(kept).toEqual([]);
    expect(dropped[0]!.reason).toMatch(/cannot be checked against your INR budget/);
  });
});

describe('transport search with a provider returning mixed currencies', () => {
  const classification: JourneyClassification = {
    scope: 'domestic',
    originCountry: 'IN',
    destinationCountry: 'IN',
    greatCircleKm: 500,
    crossesTimezones: false,
    originTimezone: 'Asia/Kolkata',
    destinationTimezone: 'Asia/Kolkata',
    surfaceRoutePlausible: true,
    eligibleModes: ['train'],
    excludedModes: [],
    documentationNotes: [],
  };

  const railReturning = (offers: TransportOffer[]) =>
    ({
      railFor: () => [{ searchTrains: async () => ok(offers, offers[0]!.provenance) }],
    }) as unknown as ProviderRegistry;

  it('compares only rupee prices instead of crashing', async () => {
    const rupees = transportOffer({ id: 'inr-train', mode: 'train', totalPrice: money(1200, 'INR') });
    const result = await searchTransport(
      {
        registry: railReturning([inEuros({ mode: 'train' }), rupees]),
        intent: intent(),
        classification,
        profile: profile(),
        constraints: buildConstraintsOnly(profile()),
      },
      'outbound',
    );

    const train = result.modes.find((m) => m.mode === 'train')!;
    expect(train.cheapest?.id).toBe('inr-train');
    expect(train.offers.map((o) => o.candidate.id)).toEqual(['inr-train']);
    expect(result.notes.some((n) => /priced in EUR/.test(n.message))).toBe(true);
  });

  it('explains a mode whose every option was in another currency', async () => {
    const result = await searchTransport(
      {
        registry: railReturning([inEuros({ mode: 'train' })]),
        intent: intent(),
        classification,
        profile: profile(),
        constraints: buildConstraintsOnly(profile()),
      },
      'outbound',
    );

    const train = result.modes.find((m) => m.mode === 'train')!;
    expect(train.note?.message).toMatch(/priced in EUR/);
    expect(train.note?.message).not.toMatch(/ruled out by your requirements/);
  });
});

describe('trips are planned in rupees', () => {
  const base = {
    originQuery: 'Hyderabad',
    destinationQuery: 'Bengaluru',
    departureDate: '2030-11-10',
    travelers: { adults: 1 },
  };

  it('defaults to INR', () => {
    expect(TripIntentInput.parse(base).currency).toBe('INR');
  });

  it('refuses any other currency with a plain explanation', () => {
    const result = TripIntentInput.safeParse({ ...base, currency: 'USD' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Trips are planned in Indian rupees (INR).');
  });
});
