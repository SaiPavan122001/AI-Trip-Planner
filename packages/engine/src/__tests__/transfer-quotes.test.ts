import { describe, expect, it } from 'vitest';
import {
  add,
  money,
  ok,
  type ItineraryItem,
  type SelectedHotel,
  type TransferOffer,
} from '@trip/shared';
import type { GroundTransportProvider, QuotedTransfer, QuotedTransferProvider, QuotedTransferRequest } from '@trip/providers';
import { computeCost } from '../cost.js';
import { hotel, intent, transportOffer } from './fixtures.js';
import { provenance, answers } from './kit.js';
import { planTrip, property, room } from './plan-kit.js';

/**
 * A transfer a provider will sell replaces the routing estimate for that leg
 * (airport to a provider hotel and back); anything it cannot do leaves the
 * estimate in place and says why. The estimate and the quote are never mixed.
 */

const descriptor = (id: string, kind: 'ground_transport' | 'transfer_quote') => ({
  id,
  label: `Test ${id}`,
  kinds: [kind],
  requiredEnv: [],
  coverage: 'global' as const,
  docsUrl: null,
  attribution: null,
});

const routing = (): GroundTransportProvider => ({
  descriptor: descriptor('routing-transfers', 'ground_transport'),
  isConfigured: () => true,
  health: async () => ok({ ok: true as const, latencyMs: 1 }, provenance('routing-transfers')),
  searchTransfers: async (req) =>
    answers.ok<TransferOffer[]>(
      [
        {
          id: `est-${req.from.name}-${req.to.name}`,
          mode: 'taxi',
          from: req.from,
          to: req.to,
          distanceKm: 35,
          durationMinutes: 55,
          vehicles: 1,
          price: money(900, 'INR'),
          priceIsEstimate: true,
          estimateBasis: 'a configured tariff',
          accessible: null,
          quote: null,
          provenance: provenance('routing-transfers'),
        },
      ],
      'routing-transfers',
    ),
});

const quote = (over: Partial<QuotedTransfer> = {}): QuotedTransfer => ({
  id: 'hotelbeds-transfer:11',
  kind: 'private',
  vehicle: 'Standard Car',
  category: 'Standard',
  minPassengers: 1,
  maxPassengers: 4,
  luggage: null,
  price: money(1800, 'INR'),
  cancellationPolicy: null,
  token: 'TOKEN-11',
  ...over,
});

function quoting(answer: (req: QuotedTransferRequest) => QuotedTransfer[]) {
  const calls: QuotedTransferRequest[] = [];
  const provider: QuotedTransferProvider = {
    descriptor: descriptor('quoter', 'transfer_quote'),
    isConfigured: () => true,
    health: async () => ok({ ok: true as const, latencyMs: 1 }, provenance('quoter')),
    quoteTransfers: async (req) => {
      calls.push(req);
      return answers.ok(answer(req), 'quoter');
    },
  };
  return { provider, calls };
}

const stay = (id: string) => [property(id, 3, [room('r-1', 24_000)])];
const transfersOf = (plan: { transfers: TransferOffer[] }) => plan.transfers;

describe('a quoted transfer replaces the routing estimate', () => {
  it('quotes the airport to a Hotelbeds hotel and back, with airport and hotel codes', async () => {
    const q = quoting(() => [quote()]);
    const { plans } = await planTrip({
      stays: stay('hotelbeds-hotel:1001'),
      parts: { groundTransport: [routing()], quotedTransfers: [q.provider] },
    });
    const plan = plans[0]!;
    const quoted = transfersOf(plan).filter((t) => t.quote !== null);
    expect(quoted).toHaveLength(2);
    expect(quoted[0]).toMatchObject({
      id: 'hotelbeds-transfer:11',
      price: { amount: 180_000, currency: 'INR' },
      priceIsEstimate: false,
      estimateBasis: null,
      // Distance and time are still the routing's.
      distanceKm: 35,
      durationMinutes: 55,
      quote: { vehicle: 'Standard Car', serviceType: 'private', maxPassengers: 4, revalidationToken: 'TOKEN-11' },
    });
    // Arrival: the airport the flight lands at, to the hotel. Return: the reverse.
    const pairs = q.calls.map((c) => `${c.from.type}:${c.from.code}>${c.to.type}:${c.to.code}`).sort();
    expect(pairs).toEqual(['ATLAS:1001>IATA:BLR', 'IATA:BLR>ATLAS:1001']);
    // Both legs are counted as quotes, not as modelled cost.
    const transferItems = plan.days.flatMap((d) => d.items).filter((i: ItineraryItem) => i.kind === 'transfer' && i.cost?.amount === 180_000);
    expect(transferItems.length).toBeGreaterThan(0);
    expect(transferItems.every((i: ItineraryItem) => !i.costIsEstimate)).toBe(true);
  });

  it('asks once for a leg although several plans are built', async () => {
    const q = quoting(() => [quote()]);
    await planTrip({ stays: stay('hotelbeds-hotel:1001'), parts: { groundTransport: [routing()], quotedTransfers: [q.provider] } });
    const keys = q.calls.map((c) => `${c.from.code}>${c.to.code}@${c.at}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('leaves the estimate for a hotel the transfer provider does not know, and does not ask', async () => {
    const q = quoting(() => [quote()]);
    const { plans } = await planTrip({
      stays: stay('amadeus-hotel:XYZ'),
      parts: { groundTransport: [routing()], quotedTransfers: [q.provider] },
    });
    expect(q.calls).toHaveLength(0);
    const transfers = transfersOf(plans[0]!);
    expect(transfers.length).toBeGreaterThan(0);
    expect(transfers.every((t) => t.quote === null && t.priceIsEstimate)).toBe(true);
  });

  it('keeps the estimate, and says nothing is converted, when the quote is in another currency', async () => {
    const q = quoting(() => [quote({ price: money(20, 'EUR') })]);
    const { plans } = await planTrip({
      stays: stay('hotelbeds-hotel:1001'),
      parts: { groundTransport: [routing()], quotedTransfers: [q.provider] },
    });
    const plan = plans[0]!;
    expect(transfersOf(plan).every((t) => t.quote === null && t.price?.currency === 'INR' && t.priceIsEstimate)).toBe(true);
    expect(plan.providerNotes.map((n) => n.message).join(' ')).toMatch(/quoted this transfer in EUR.*Nothing is converted/);
  });

  it('keeps the estimate when no vehicle carries the party', async () => {
    const q = quoting(() => [quote({ maxPassengers: 1 })]);
    const { plans } = await planTrip({
      stays: stay('hotelbeds-hotel:1001'),
      parts: { groundTransport: [routing()], quotedTransfers: [q.provider] },
    });
    expect(transfersOf(plans[0]!).every((t) => t.quote === null)).toBe(true);
    expect(plans[0]!.providerNotes.map((n) => n.message).join(' ')).toMatch(/no vehicle for this party/);
  });

  it('keeps the estimate and reports the failure when the quote call fails', async () => {
    const provider: QuotedTransferProvider = {
      ...quoting(() => []).provider,
      quoteTransfers: async () => answers.down('quoter'),
    };
    const { plans } = await planTrip({
      stays: stay('hotelbeds-hotel:1001'),
      parts: { groundTransport: [routing()], quotedTransfers: [provider] },
    });
    expect(transfersOf(plans[0]!).every((t) => t.quote === null && t.priceIsEstimate)).toBe(true);
    expect(plans[0]!.providerNotes.some((n) => n.provider === 'quoter')).toBe(true);
  });

  it('picks the cheapest vehicle that fits, and a shared shuttle is a shuttle', async () => {
    const q = quoting(() => [
      quote({ id: 'a', price: money(2600, 'INR'), maxPassengers: 8 }),
      quote({ id: 'b', kind: 'shared', price: money(700, 'INR'), maxPassengers: 12 }),
      quote({ id: 'c', price: money(1800, 'INR'), maxPassengers: 4 }),
    ]);
    const { plans } = await planTrip({
      stays: stay('hotelbeds-hotel:1001'),
      parts: { groundTransport: [routing()], quotedTransfers: [q.provider] },
    });
    const first = transfersOf(plans[0]!).find((t) => t.quote !== null)!;
    expect(first.id).toBe('b');
    expect(first.mode).toBe('shuttle');
  });
});

describe('cost with provider hotel taxes and estimated fares', () => {
  const tripIntent = intent();
  const base = hotel();
  const selected = (payAtProperty: ReturnType<typeof money> | null): SelectedHotel => ({
    hotel: base,
    room: { ...base.rooms[0]!, totalPrice: money(24_000, 'INR'), payAtProperty },
    nights: 4,
    rooms: 2,
    // Present on the type for the planner's own use.
  } as unknown as SelectedHotel);

  const constraints = {
    hard: [],
    soft: [],
    budget: { total: null, transport: null, accommodation: null, dailySpend: null, activities: null, firm: false },
    waivers: [],
  };

  it('adds taxes collected at the property to the stay, for every room', () => {
    const without = computeCost({ intent: tripIntent, items: [], outbound: null, inbound: null, hotel: selected(null), constraints });
    const withTax = computeCost({ intent: tripIntent, items: [], outbound: null, inbound: null, hotel: selected(money(1_500, 'INR')), constraints });
    expect(without.accommodation).toEqual(money(48_000, 'INR'));
    expect(withTax.accommodation).toEqual(add(money(48_000, 'INR'), money(3_000, 'INR')));
    expect(withTax.total).toEqual(withTax.accommodation);
  });

  it('counts an estimated fare that is the whole fare as modelled, without adding it twice', () => {
    const offer = transportOffer({
      totalPrice: money(6_000, 'INR'),
      itemisedFees: [{ label: 'Estimated bus fare', amount: money(6_000, 'INR'), included: true, isEstimate: true, basis: 'configured assumptions' }],
    });
    const cost = computeCost({ intent: tripIntent, items: [], outbound: offer, inbound: null, hotel: null, constraints });
    expect(cost.transport).toEqual(money(6_000, 'INR'));
    expect(cost.total).toEqual(money(6_000, 'INR'));
    expect(cost.estimatedPortion).toEqual(money(6_000, 'INR'));
  });

  it('counts a quote as quoted: it is not part of the modelled portion', () => {
    const item: ItineraryItem = {
      id: 't1',
      kind: 'transfer',
      title: 'Transfer',
      description: null,
      startUtc: '2026-11-11T04:00:00.000Z',
      endUtc: '2026-11-11T05:00:00.000Z',
      timezone: 'Asia/Kolkata',
      locationName: null,
      cost: money(1_800, 'INR'),
      costIsEstimate: false,
      offerRef: null,
      notes: [],
    };
    const cost = computeCost({ intent: tripIntent, items: [item], outbound: null, inbound: null, hotel: null, constraints });
    expect(cost.localTransport).toEqual(money(1_800, 'INR'));
    expect(cost.estimatedPortion).toEqual(money(0, 'INR'));
  });
});
