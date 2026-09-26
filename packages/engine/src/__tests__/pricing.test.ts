import { describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@trip/providers';
import {
  money,
  ok,
  type ItineraryItem,
  type JourneyClassification,
  type TransportOffer,
} from '@trip/shared';
import { computeCost } from '../cost.js';
import { knownTransportCost } from '../pricing.js';
import { applyHardConstraints, searchTransport } from '../transport.js';
import { validateItinerary } from '../validate.js';
import { classifyJourney } from '../classify.js';
import { buildConstraintsOnly, intent, profile, transportOffer, INDIA_LEG } from './fixtures.js';

/**
 * Pricing rules for the India product:
 *  - Driving your own car has a known fare of ₹0 and is compared as ₹0.
 *  - Fuel and wear are counted, as estimates, only when they can be
 *    calculated; tolls and parking are never counted as zero.
 *  - Anything nobody can price is listed as not included in the total.
 */

const drive = (withProfile: boolean): TransportOffer =>
  transportOffer({
    id: withProfile ? 'drive-profile' : 'drive-bare',
    mode: 'self_drive',
    totalPrice: money(0, 'INR'),
    pricePerTraveler: money(0, 'INR'),
    fareClasses: [],
    itemisedFees: withProfile
      ? [
          { label: 'Fuel', amount: money(1181.25, 'INR'), included: false, isEstimate: true, basis: 'profile' },
          { label: 'Wear and tear', amount: money(225, 'INR'), included: false, isEstimate: true, basis: 'profile' },
        ]
      : [],
    unpricedCosts: withProfile ? ['Tolls', 'Parking'] : ['Fuel', 'Wear and tear', 'Tolls', 'Parking'],
  });

const train = (rupees: number) =>
  transportOffer({ id: `train-${rupees}`, mode: 'train', totalPrice: money(rupees, 'INR'), fareClasses: [] });

describe('what an option is known to cost', () => {
  it('is ₹0 for your own car when running costs cannot be calculated', () => {
    expect(knownTransportCost(drive(false))).toEqual(money(0, 'INR'));
  });

  it('adds estimated fuel and wear when they can be calculated', () => {
    expect(knownTransportCost(drive(true))).toEqual(money(1406.25, 'INR'));
  });

  it('does not add fees that are already inside the fare', () => {
    const flight = transportOffer({
      itemisedFees: [{ label: 'Taxes', amount: money(900, 'INR'), included: true, isEstimate: false, basis: null }],
    });
    expect(knownTransportCost(flight)).toEqual(flight.totalPrice);
  });
});

describe('comparing self-drive with other transport', () => {
  const classification: JourneyClassification = {
    ...classifyJourney(intent().origin, intent().destination),
    eligibleModes: ['train', 'self_drive'],
  };
  const registry = (driveOffer: TransportOffer, trains: TransportOffer[]) =>
    ({
      railFor: () => [{ searchTrains: async () => ok(trains, trains[0]!.provenance) }],
      selfDrive: { estimate: async () => ok(driveOffer, driveOffer.provenance) },
    }) as unknown as ProviderRegistry;

  const search = (driveOffer: TransportOffer) =>
    searchTransport(
      {
        registry: registry(driveOffer, [train(1200)]),
        intent: intent(),
        classification,
        profile: profile(),
        constraints: buildConstraintsOnly(profile()),
      },
      'outbound',
    );

  it('treats a ₹0 drive as a real ₹0, so it can be the cheapest option', async () => {
    const result = await search(drive(false));
    const selfDrive = result.modes.find((m) => m.mode === 'self_drive')!;
    // Compared, not set aside as "unknown".
    expect(selfDrive.offers).toHaveLength(1);
    expect(selfDrive.cheapest?.totalPrice).toEqual(money(0, 'INR'));
  });

  it('compares a drive on fare plus estimated fuel and wear when those are known', () => {
    // A ₹1,200 train beats a drive whose fuel and wear come to ₹1,406.25.
    const cheaper = [drive(true), train(1200)].sort(
      (a, b) => knownTransportCost(a).amount - knownTransportCost(b).amount,
    )[0]!;
    expect(cheaper.id).toBe('train-1200');
  });

  it('holds a drive to the transport budget on what it is known to cost', () => {
    const p = profile();
    const constraints = {
      ...buildConstraintsOnly(p),
      budget: { total: null, transport: money(1300, 'INR'), accommodation: null, dailySpend: null, activities: null },
    };
    const { kept, dropped } = applyHardConstraints([drive(true), drive(false)], constraints, p, INDIA_LEG);
    expect(kept.map((o) => o.id)).toEqual(['drive-bare']);
    expect(dropped[0]!.offerId).toBe('drive-profile');
  });
});

describe('the cost breakdown', () => {
  const base = { intent: intent(), outbound: null, inbound: null, hotel: null, constraints: buildConstraintsOnly(profile()) };
  const item = (kind: ItineraryItem['kind'], cost: ItineraryItem['cost']): ItineraryItem => ({
    id: `${kind}-1`, kind, title: kind, description: null,
    startUtc: '2026-11-11T04:00:00.000Z', endUtc: '2026-11-11T05:00:00.000Z', timezone: 'Asia/Kolkata',
    locationName: null, cost, costIsEstimate: false, offerRef: null, notes: [],
  });

  it('counts a drive’s fuel and wear as estimated transport costs', () => {
    const cost = computeCost({ ...base, items: [], outbound: drive(true) });
    expect(cost.transport).toEqual(money(0, 'INR'));
    expect(cost.transportFees).toEqual(money(1406.25, 'INR'));
    expect(cost.estimatedPortion).toEqual(money(1406.25, 'INR'));
    expect(cost.notIncluded.map((n) => n.label)).toEqual(['Tolls', 'Parking']);
  });

  it('never counts uncalculated running costs as zero', () => {
    const cost = computeCost({ ...base, items: [], outbound: drive(false) });
    expect(cost.total).toEqual(money(0, 'INR'));
    expect(cost.notIncluded.map((n) => n.label)).toEqual(['Fuel', 'Wear and tear', 'Tolls', 'Parking']);
  });

  it('lists unpriced transfers, entry fees and meals instead of dropping them silently', () => {
    const cost = computeCost({
      ...base,
      items: [item('transfer', null), item('transfer', null), item('activity', null), item('meal', null)],
    });
    expect(cost.notIncluded.map((n) => n.label)).toEqual(['Local travel (2 legs)', 'Entry to 1 place', 'Food']);
  });

  it('is complete when everything is priced', () => {
    const cost = computeCost({ ...base, items: [item('transfer', money(300, 'INR'))], outbound: train(1200) });
    expect(cost.notIncluded).toEqual([]);
  });

  it('makes the validator say the total may rise when a budget is set', () => {
    const p = profile();
    const constraints = {
      ...buildConstraintsOnly(p),
      budget: { total: money(50_000, 'INR'), transport: null, accommodation: null, dailySpend: null, activities: null },
    };
    const cost = computeCost({ ...base, constraints, items: [], outbound: drive(false) });
    const issues = validateItinerary({
      intent: intent(),
      classification: classifyJourney(intent().origin, intent().destination),
      profile: p,
      constraints,
      items: [],
      cost,
      outbound: drive(false),
      inbound: null,
      hotel: null,
    });
    const incomplete = issues.find((i) => i.code === 'total_incomplete');
    expect(incomplete?.severity).toBe('warning');
    expect(incomplete?.message).toMatch(/does not include fuel, wear and tear, tolls, parking/);
  });
});
