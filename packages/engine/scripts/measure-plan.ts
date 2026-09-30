/**
 * Measures where a plan search spends its time and its provider calls, with
 * fake providers that each take a fixed time to answer. It calls nothing on the
 * network and needs no credentials.
 *
 *   npx tsx packages/engine/scripts/measure-plan.ts
 *
 * Phase 5 rule: measure before optimising. The numbers this prints are what the
 * optimisations in `plans.ts` were judged against (see PROJECT_STATUS.md).
 */
import { IsolatingPolicy, ProviderRegistry, loadProvidersEnv, type GroundTransportProvider } from '@trip/providers';
import { ActivityOffer, money, ok, type ConstraintSet, type TravelerProfile } from '@trip/shared';
import { buildConstraints } from '../src/constraints.js';
import { generatePlans } from '../src/plans.js';
import { emptyTravelerProfile } from '@trip/shared';
import { intent as baseIntent } from '../src/__tests__/fixtures.js';
import { activityProvider, answers, flightProvider, hotelProvider, provenance } from '../src/__tests__/kit.js';
import { journey, property, room } from '../src/__tests__/plan-kit.js';

const LATENCY_MS = Number(process.env['LATENCY_MS'] ?? 150);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const calls = new Map<string, number>();
const count = (op: string) => calls.set(op, (calls.get(op) ?? 0) + 1);

const place = (i: number) =>
  ActivityOffer.parse({
    id: `a-${i}`,
    name: `Place ${i}`,
    coordinates: { lat: 12.95 + (i % 5) * 0.01, lon: 77.58 + Math.floor(i / 5) * 0.01 },
    typicalDurationMinutes: 90,
    rating: 4.2,
    provenance: provenance('places'),
  });

function build(): ProviderRegistry {
  const registry = new ProviderRegistry(loadProvidersEnv({}), new IsolatingPolicy({ deadlineMs: null }));
  const date = '2026-11-10';
  registry.flights.push(
    flightProvider('flights', async (req: { departureDate: string; origin: { name: string } }) => {
      count('searchFlights');
      await sleep(LATENCY_MS);
      const back = req.origin.name !== 'Hyderabad';
      return answers.ok(
        [0, 1, 2, 3, 4, 5].map((i) =>
          journey({ id: `f${i}`, rupees: 6_000 + i * 1_500, departs: 6 * 60 + i * 90, minutes: 75 + i * 10 }, req.departureDate || date, back ? 'BLR' : 'HYD', back ? 'HYD' : 'BLR'),
        ),
      );
    }),
  );
  registry.hotels.push(
    hotelProvider('hotels', async () => {
      count('searchHotels');
      await sleep(LATENCY_MS);
      return answers.ok([0, 1, 2, 3].map((i) => property(`h${i}`, 2 + i, [room(`r${i}`, 12_000 + i * 6_000)], 12.95 + i * 0.01)));
    }),
  );
  registry.activities.push(
    activityProvider('places', async () => {
      count('searchActivities');
      await sleep(LATENCY_MS);
      return answers.ok(Array.from({ length: 14 }, (_, i) => place(i)));
    }),
  );
  const transfers: GroundTransportProvider = {
    descriptor: { id: 'osrm-transfer', label: 'Transfers', kinds: ['ground_transport'], requiredEnv: [], coverage: 'global', docsUrl: null, attribution: null },
    isConfigured: () => true,
    health: async () => ok({ ok: true as const, latencyMs: 1 }, provenance('transfers')),
    searchTransfers: async (req) => {
      count('searchTransfers');
      await sleep(LATENCY_MS);
      return ok(
        [
          {
            id: `t-${req.from.name}-${req.to.name}`,
            mode: 'taxi' as const,
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
          },
        ],
        provenance('transfers'),
      );
    },
  };
  registry.groundTransport.push(transfers);
  return registry;
}

async function scenario(name: string, budgetTotal: number | null, firm: boolean) {
  calls.clear();
  const registry = build();
  const intent = baseIntent({ returnDate: '2026-11-14' });
  const profile: TravelerProfile = emptyTravelerProfile();
  const constraints: ConstraintSet = buildConstraints(intent, profile, {
    total: budgetTotal ? money(budgetTotal, 'INR') : null,
    firm,
    transport: null,
    accommodation: null,
    dailySpendPerPerson: null,
  } as never);
  const started = Date.now();
  const result = await generatePlans({ registry, intent, profile, constraints });
  const elapsed = Date.now() - started;
  const total = [...calls.values()].reduce((a, b) => a + b, 0);
  console.log(`\n${name}`);
  console.log(`  wall time ${elapsed} ms with ${LATENCY_MS} ms per provider call; ${total} provider calls; ${result.plans.length} plans`);
  console.log(`  calls: ${[...calls].map(([k, v]) => `${k}=${v}`).join(', ')}`);
}

await scenario('Guide budget (one itinerary per plan)', null, false);
await scenario('Firm budget that most combinations exceed (up to 4 itineraries per plan)', 52_000, true);
