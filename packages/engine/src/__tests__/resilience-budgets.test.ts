import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry, ResilientPolicy, currentScope, loadProvidersEnv, type GroundTransportProvider } from '@trip/providers';
import { Deadline, money, ok, statusClass, type TransferOffer } from '@trip/shared';
import { generatePlans } from '../plans.js';
import { buildConstraintsOnly, hotel, intent, profile, transportOffer } from './fixtures.js';
import { activityProvider, answers, flightProvider, hotelProvider, never, provenance } from './kit.js';

/**
 * The layered time model and the failure modes around it (Phase 5.6, 5.9, 5.11):
 *
 *   the search's deadline
 *     -> a share for each stage (journeys and things to do, then stays, then itineraries)
 *       -> each provider call's own ceiling
 *         -> each HTTP attempt's timeout
 *
 * A provider that hangs costs its own results and only the time its stage was
 * allowed; the stages after it still run.
 */

const flightsOk = () => flightProvider('flights', async () => answers.ok([{ ...transportOffer(), id: 'f1', totalPrice: money(9600, 'INR') }]));
const hotelsOk = () => hotelProvider('hotels', async () => answers.ok([hotel()]));

/** A registry on the real resilient policy (a 45 s call ceiling, so only the stage budgets can stop a hang). */
function registryOn(parts: {
  flights?: ReturnType<typeof flightProvider>[];
  hotels?: ReturnType<typeof hotelProvider>[];
  activities?: ReturnType<typeof activityProvider>[];
  transfers?: GroundTransportProvider[];
  policy?: ResilientPolicy;
}): ProviderRegistry {
  const registry = new ProviderRegistry(
    loadProvidersEnv({ CACHE_ENABLED: 'false' }),
    parts.policy ?? new ResilientPolicy({ deadlineMs: 45_000, circuit: { failureThreshold: 3, recoveryTimeoutMs: 60_000 } }),
  );
  registry.flights.push(...(parts.flights ?? []));
  registry.hotels.push(...(parts.hotels ?? []));
  registry.activities.push(...(parts.activities ?? []));
  registry.groundTransport.push(...(parts.transfers ?? []));
  return registry;
}

const transferProvider = (answer: (req: Parameters<GroundTransportProvider['searchTransfers']>[0]) => ReturnType<GroundTransportProvider['searchTransfers']>): GroundTransportProvider => ({
  descriptor: { id: 'transfers', label: 'Test transfers', kinds: ['ground_transport'], requiredEnv: [], coverage: 'global', docsUrl: null, attribution: null },
  isConfigured: () => true,
  health: async () => ok({ ok: true as const, latencyMs: 1 }, provenance('transfers')),
  searchTransfers: answer,
});

const taxi = (req: { from: TransferOffer['from']; to: TransferOffer['to'] }): TransferOffer => ({
  id: `t-${req.from.name}-${req.to.name}`,
  mode: 'taxi',
  from: req.from,
  to: req.to,
  distanceKm: 12,
  durationMinutes: 30,
  vehicles: 1,
  price: money(600, 'INR'),
  priceIsEstimate: true,
  estimateBasis: 'test',
  accessible: null,
  provenance: provenance('transfers'),
});

const plan = (registry: ProviderRegistry, extra: Partial<Parameters<typeof generatePlans>[0]> = {}) => {
  const p = profile();
  return generatePlans({ registry, intent: intent(), profile: p, constraints: buildConstraintsOnly(p), ...extra });
};

let started = 0;
const elapsed = () => Date.now() - started;
afterEach(() => {
  started = 0;
});

describe('a slow provider costs its own results, not the search', () => {
  it('a flight search that hangs is cut off at its stage, and the hotels are still searched and planned', async () => {
    const registry = registryOn({
      flights: [flightProvider('flights', never)],
      hotels: [hotelsOk()],
    });
    started = Date.now();
    const result = await plan(registry, { deadline: Deadline.after(1_500) });

    // The flight search was cut off near its share of the time (45% of 1.5 s), not at 45 s.
    expect(elapsed()).toBeLessThan(1_500);
    const note = result.notes.find((n) => n.capability === 'flights');
    expect(note).toBeDefined();
    expect(statusClass(note!.status)).toBe('timed_out');
    // The stages after it still ran: the stay was found and a plan built around it.
    expect(result.plans.length).toBeGreaterThan(0);
    expect(result.plans[0]!.hotels).toHaveLength(1);
    expect(result.plans[0]!.outboundTransport).toBeNull();
  });

  it('a hotel search that hangs cannot stop the journeys being planned', async () => {
    const registry = registryOn({ flights: [flightsOk()], hotels: [hotelProvider('hotels', never)] });
    started = Date.now();
    const result = await plan(registry, { deadline: Deadline.after(1_500) });
    expect(elapsed()).toBeLessThan(1_500);
    expect(result.plans.length).toBeGreaterThan(0);
    expect(result.plans[0]!.outboundTransport).not.toBeNull();
    const note = result.notes.find((n) => n.capability === 'hotels');
    expect(statusClass(note!.status)).toBe('timed_out');
  });

  it('several providers hanging at once still leave time to answer with what did work', async () => {
    const registry = registryOn({
      flights: [flightsOk()],
      hotels: [hotelsOk()],
      activities: [activityProvider('places', never)],
    });
    started = Date.now();
    const result = await plan(registry, { deadline: Deadline.after(1_200) });
    expect(elapsed()).toBeLessThan(1_200);
    expect(result.plans.length).toBeGreaterThan(0);
    expect(result.notes.some((n) => n.capability === 'activities' && statusClass(n.status) === 'timed_out')).toBe(true);
  });

  it('a transfer lookup that hangs is cut off inside the time the itineraries were allowed', async () => {
    const registry = registryOn({
      flights: [flightsOk()],
      hotels: [hotelsOk()],
      transfers: [transferProvider(never)],
    });
    started = Date.now();
    const result = await plan(registry, { deadline: Deadline.after(1_500) });
    expect(elapsed()).toBeLessThan(1_600);
    expect(result.plans.length).toBeGreaterThan(0);
    // The plan says the transfer could not be measured; it does not invent a time or a fare.
    expect(result.notes.concat(result.plans[0]!.providerNotes as never).some((n) => (n as { capability?: string }).capability === 'transfers')).toBe(true);
  });

  it('without a deadline, nothing is stopped early: only each call\'s own ceiling applies', async () => {
    const registry = registryOn({ flights: [flightsOk()], hotels: [hotelsOk()] });
    const result = await plan(registry);
    expect(result.plans.length).toBeGreaterThan(0);
  });
});

describe('cancellation reaches everything the search started', () => {
  it('aborts a transfer lookup that is in flight, although the transfer request carries no signal of its own', async () => {
    let seen: AbortSignal | undefined;
    let aborted = false;
    const registry = registryOn({
      flights: [flightsOk()],
      hotels: [hotelsOk()],
      transfers: [
        transferProvider(
          (_req) =>
            new Promise((_resolve) => {
              seen = currentScope()?.signal;
              seen?.addEventListener('abort', () => (aborted = true));
            }),
        ),
      ],
    });
    const controller = new AbortController();
    const search = plan(registry, { signal: controller.signal });
    search.catch(() => undefined);
    // Wait until the search has reached the transfers, then cancel it.
    for (let i = 0; i < 200 && !seen; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(seen).toBeDefined();
    controller.abort(new Error('the traveller cancelled'));
    await expect(search).rejects.toThrow('the traveller cancelled');
    expect(aborted).toBe(true);
  });
});

describe('the same leg is asked for once per search', () => {
  it('shares one transfer lookup between the plans that need it', async () => {
    let asked = 0;
    const registry = registryOn({
      flights: [flightsOk()],
      hotels: [hotelsOk()],
      transfers: [transferProvider(async (req) => (asked += 1, ok([taxi(req)], provenance('transfers'))))],
    });
    const result = await plan(registry);
    // One journey each way and one stay: every plan is built from the same
    // three legs (home to airport, airport to hotel, hotel to airport).
    expect(result.plans.length).toBeGreaterThan(0);
    expect(asked).toBeLessThanOrEqual(3);
  });
});

describe('a provider that keeps failing is left alone', () => {
  it('stops being called across searches once its circuit is open, and says why', async () => {
    let flightCalls = 0;
    const registry = registryOn({
      flights: [flightProvider('flights', async () => (flightCalls += 1, answers.down('flights')))],
      hotels: [hotelsOk()],
    });
    const notes: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const result = await plan(registry);
      notes.push(result.notes.find((n) => n.capability === 'flights')?.message ?? '');
      expect(result.plans.length).toBeGreaterThan(0); // the stay is still planned
    }
    // Two outward/return searches per plan, a threshold of three: it opens during the second search and is not called again.
    expect(flightCalls).toBeLessThanOrEqual(4);
    expect(notes.at(-1)).toMatch(/not asked/);
    // The traveller is told what the last real failure was, not just that it was skipped.
    expect(notes.at(-1)).toMatch(/returned an error/);
  });

  it('every provider down: no plans, a note for each thing that failed, no exception, nothing invented', async () => {
    const registry = registryOn({
      flights: [flightProvider('flights', async () => answers.down('flights'))],
      hotels: [hotelProvider('hotels', async () => answers.unusable('hotels'))],
      activities: [activityProvider('places', async () => answers.rateLimited('places'))],
    });
    const result = await plan(registry);
    expect(result.plans).toEqual([]);
    const capabilities = new Set(result.notes.map((n) => n.capability));
    expect(capabilities).toContain('flights');
    expect(capabilities).toContain('hotels');
    expect(capabilities).toContain('activities');
    expect(JSON.stringify(result)).not.toMatch(/at .*\.(ts|js):\d+/); // no stack traces
  });

  it('partial results: one capability failing does not remove what another found', async () => {
    const registry = registryOn({
      flights: [flightProvider('flights', async () => answers.rateLimited('flights'))],
      hotels: [hotelsOk()],
    });
    const result = await plan(registry);
    expect(result.plans[0]!.hotels).toHaveLength(1);
    expect(result.notes.find((n) => n.capability === 'flights')?.status).toBe('rate_limited');
  });
});
