import { describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@trip/providers';
import { money, ok, type TransportOffer } from '@trip/shared';
import { buildConstraints } from '../constraints.js';
import { generatePlans, type PlanProgress } from '../plans.js';
import { hotel, intent, profile, transportOffer } from './fixtures.js';

/**
 * A search runs in the background and can be cancelled, so it reports where
 * it is, stops when told to, and hands its signal to the providers it calls.
 */

const flightOn = (date: string, hour: string): TransportOffer =>
  transportOffer({
    id: `f-${date}`,
    totalPrice: money(9_000, 'INR'),
    segments: [
      { ...transportOffer().segments[0]!, departureAt: `${date}T${hour}:00:00`, arrivalAt: `${date}T${Number(hour) + 1}:15:00` },
    ],
  });

function registry(searchFlights: (req: { departureDate: string; signal?: AbortSignal }) => Promise<unknown>): ProviderRegistry {
  const stay = hotel();
  return {
    flights: [{ searchFlights }],
    railFor: () => [],
    busesFor: () => [],
    selfDrive: null,
    amadeus: null,
    activities: [],
    groundTransport: [],
    taxiTariffs: {},
    hotels: [{ searchHotels: async () => ok([stay], stay.provenance) }],
    missingCapabilityNote: (capability: string) => ({
      status: 'not_configured' as const,
      provider: 'none',
      providerLabel: capability,
      message: `${capability} is not configured.`,
      occurredAt: '2026-01-01T00:00:00.000Z',
    }),
  } as unknown as ProviderRegistry;
}

const quickFlights = async (req: { departureDate: string }) => {
  const offer = flightOn(req.departureDate, req.departureDate === '2026-11-14' ? '16' : '10');
  return ok([offer], offer.provenance);
};

function inputs() {
  const p = profile({ priorities: ['cheapest'] });
  const tripIntent = intent();
  return {
    intent: tripIntent,
    profile: p,
    constraints: buildConstraints(tripIntent, p, {
      total: null,
      transport: null,
      accommodation: null,
      dailySpendPerPerson: null,
    }),
  };
}

describe('progress', () => {
  it('reports each stage in order, never going backwards, and stays under 100', async () => {
    const seen: PlanProgress[] = [];
    await generatePlans({ registry: registry(quickFlights), ...inputs(), onProgress: (p) => seen.push(p) });

    const steps = [...new Set(seen.map((p) => p.step))];
    expect(steps).toEqual(['classify', 'search', 'hotels', 'assemble', 'rank']);
    const percents = seen.map((p) => p.percent);
    expect([...percents].sort((a, b) => a - b)).toEqual(percents);
    expect(Math.max(...percents)).toBeLessThan(100);
    for (const p of seen) expect(p.label.length).toBeGreaterThan(0);
  });
});

describe('cancelling a search', () => {
  it('refuses to start when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    await expect(
      generatePlans({ registry: registry(quickFlights), ...inputs(), signal: controller.signal }),
    ).rejects.toThrow('stopped');
  });

  it('stops between stages, before anything more is searched', async () => {
    const controller = new AbortController();
    let hotelSearched = false;
    const reg = registry(quickFlights);
    (reg as unknown as { hotels: unknown[] }).hotels = [
      {
        searchHotels: async () => {
          hotelSearched = true;
          return ok([hotel()], hotel().provenance);
        },
      },
    ];
    await expect(
      generatePlans({
        registry: reg,
        ...inputs(),
        signal: controller.signal,
        // Cancel as soon as the hotel stage is announced.
        onProgress: (p) => {
          if (p.step === 'hotels') controller.abort(new Error('stopped'));
        },
      }),
    ).rejects.toThrow('stopped');
    expect(hotelSearched).toBe(false);
  });

  it('hands the signal to providers, so a call in flight can be cut short', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const slow = async (req: { signal?: AbortSignal }) => {
      received = req.signal;
      await new Promise((_, reject) => {
        req.signal?.addEventListener('abort', () => reject(req.signal?.reason));
      });
      return ok([], flightOn('2026-11-10', '10').provenance);
    };

    const started = Date.now();
    const search = generatePlans({ registry: registry(slow), ...inputs(), signal: controller.signal });
    setTimeout(() => controller.abort(new Error('stopped')), 30);

    await expect(search).rejects.toThrow('stopped');
    expect(received).toBe(controller.signal);
    // It ended when told to, not when the provider would have given up.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
