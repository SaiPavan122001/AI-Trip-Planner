import { describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@trip/providers';
import { money, ok, type SelectedHotel, type TransportOffer } from '@trip/shared';
import { generatePlans } from '../plans.js';
import { buildConstraintsOnly, hotel, intent, profile, transportOffer } from './fixtures.js';

/**
 * Kept parts of a plan are used exactly as they were, and are not searched
 * again. These providers throw if they are called for something that was
 * kept, so a test passes only when the pin is genuinely honoured.
 */

const flight = (id: string, rupees: number, date = '2026-11-10') =>
  transportOffer({
    id,
    totalPrice: money(rupees, 'INR'),
    segments: [{ ...transportOffer().segments[0]!, departureAt: `${date}T10:00:00`, arrivalAt: `${date}T11:15:00` }],
  });
const train = (id: string, rupees: number) =>
  transportOffer({ id, mode: 'train', totalPrice: money(rupees, 'INR'), fareClasses: [] });

function registry(opts: { flights?: TransportOffer[]; trains?: TransportOffer[]; hotelSearchAllowed?: boolean } = {}) {
  const calls = { flights: 0, hotels: 0 };
  const reg = {
    flights: [
      {
        searchFlights: async () => {
          calls.flights += 1;
          const offers = opts.flights ?? [flight('f-new', 7000)];
          return ok(offers, offers[0]!.provenance);
        },
      },
    ],
    railFor: () =>
      opts.trains ? [{ searchTrains: async () => ok(opts.trains!, opts.trains![0]!.provenance) }] : [],
    busesFor: () => [],
    selfDrive: null,
    amadeus: null,
    activities: [],
    groundTransport: [],
    taxiTariffs: {},
    hotels: [
      {
        searchHotels: async () => {
          calls.hotels += 1;
          if (!opts.hotelSearchAllowed) throw new Error('hotel search must not run when the hotel is kept');
          const h = hotel({ id: 'h-new' });
          return ok([h], h.provenance);
        },
      },
    ],
    missingCapabilityNote: (capability: string) => ({
      status: 'not_configured' as const,
      provider: 'none',
      providerLabel: capability,
      message: `${capability} is not configured.`,
      occurredAt: '2026-01-01T00:00:00.000Z',
    }),
  };
  return { registry: reg as unknown as ProviderRegistry, calls };
}

const keptHotel = (): SelectedHotel => {
  const h = hotel({ id: 'h-kept', name: 'The Kept Hotel' });
  return {
    hotel: h,
    room: h.rooms[0]!,
    rooms: 1,
    checkIn: '2026-11-10',
    checkOut: '2026-11-14',
    nights: 4,
    distanceToActivitiesKm: null,
    impliedDailyTransportCost: null,
  };
};

describe('keeping parts of a plan', () => {
  it('uses a kept hotel in every plan without searching for hotels', async () => {
    const { registry: reg, calls } = registry();
    const p = profile();
    const result = await generatePlans({
      registry: reg,
      intent: intent(),
      profile: p,
      constraints: buildConstraintsOnly(p),
      keep: { hotel: keptHotel() },
    });

    expect(calls.hotels).toBe(0);
    expect(result.plans.length).toBeGreaterThan(0);
    for (const plan of result.plans) expect(plan.hotels[0]?.hotel.id).toBe('h-kept');
    expect(result.notes.some((n) => /Kept from your earlier plan: the hotel/.test(n.message))).toBe(true);
    // The transport is still re-optimised.
    expect(calls.flights).toBeGreaterThan(0);
  });

  it('uses a kept outbound journey without searching for it again', async () => {
    const { registry: reg, calls } = registry({ flights: [flight('f-return', 6000, '2026-11-14')], hotelSearchAllowed: true });
    const p = profile();
    const kept = flight('f-kept', 9000);
    const result = await generatePlans({
      registry: reg,
      intent: intent(),
      profile: p,
      constraints: buildConstraintsOnly(p),
      keep: { outbound: kept },
    });

    // Only the return leg was searched.
    expect(calls.flights).toBe(1);
    for (const plan of result.plans) expect(plan.outboundTransport?.id).toBe('f-kept');
  });
});

describe('a preferred way of travelling', () => {
  it('steers every plan to it while still showing the others', async () => {
    const { registry: reg } = registry({
      flights: [flight('f-cheap', 3000)],
      trains: [train('t-1', 4000)],
      hotelSearchAllowed: true,
    });
    const p = profile();
    p.transport.preferredMode = 'train';
    const result = await generatePlans({ registry: reg, intent: intent({ returnDate: null }), profile: p, constraints: buildConstraintsOnly(p) });

    for (const plan of result.plans) expect(plan.outboundTransport?.mode).toBe('train');
    // Flights are still in the comparison, so the traveller can see the trade-off.
    expect(result.transport.outbound.modes.find((m) => m.mode === 'flight')?.offers).toHaveLength(1);
  });

  it('says so when the preferred mode has nothing, and uses the alternatives', async () => {
    const { registry: reg } = registry({ flights: [flight('f-only', 3000)], hotelSearchAllowed: true });
    const p = profile();
    p.transport.preferredMode = 'train';
    const result = await generatePlans({ registry: reg, intent: intent({ returnDate: null }), profile: p, constraints: buildConstraintsOnly(p) });

    expect(result.plans[0]?.outboundTransport?.id).toBe('f-only');
    expect(result.notes.some((n) => /asked to travel by train, but no such option/.test(n.message))).toBe(true);
  });
});
