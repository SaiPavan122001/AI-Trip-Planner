import { ProviderRegistry, loadProvidersEnv } from '@trip/providers';
import {
  LlmInvalidOutputError,
  LlmUnavailableError,
  TripLlm,
  type ExtractRequest,
  type LlmProvider,
} from '@trip/llm';
import { buildConstraints, classifyJourney } from '@trip/engine';
import {
  emptyTravelerProfile,
  money,
  ok,
  type HotelOffer,
  type Place,
  type TransportOffer,
  type TravelerProfile,
  type TripIntent,
} from '@trip/shared';

/** Shared fixtures for the agent tests: real places, offline providers, a scriptable "model". */

export const TODAY = '2030-01-15';

export interface LlmCall {
  system: string;
  input: string;
  schemaName: string;
}

/**
 * A model that answers from a function. What it returns is checked against the
 * request's schema exactly as a real provider does: a shape mismatch becomes
 * `LlmInvalidOutputError`, and returning an Error makes the model unavailable.
 */
export function fakeLlm(respond: (call: LlmCall) => unknown): { llm: TripLlm; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  const provider: LlmProvider = {
    id: 'fake',
    label: 'Fake model',
    model: 'fake-1',
    isConfigured: () => true,
    async extract<T>(req: ExtractRequest<T>) {
      const call = { system: req.system, input: req.input, schemaName: req.schemaName };
      calls.push(call);
      const answer = respond(call);
      if (answer instanceof Error) throw new LlmUnavailableError('fake', answer.message);
      const parsed = req.schema.safeParse(answer);
      if (!parsed.success) throw new LlmInvalidOutputError('fake', 'Structured output failed validation');
      return {
        data: parsed.data,
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
        model: 'fake-1',
        fromFallback: false,
      };
    },
  };
  return { llm: new TripLlm(provider), calls };
}

export const noModel = () => new TripLlm(null);

// ------------------------------------------------------------------ places

const place = (id: string, name: string, lat: number, lon: number, iata: string): Place => ({
  id,
  name,
  displayName: `${name}, India`,
  coordinates: { lat, lon },
  countryCode: 'IN',
  countryName: 'India',
  timezone: 'Asia/Kolkata',
  airports: [{ iataCode: iata, name: `${name} airport`, distanceKm: 20, coordinates: null }],
  source: 'test',
  resolvedAt: '2026-01-01T00:00:00.000Z',
});

export const hyderabad = place('p1', 'Hyderabad', 17.385, 78.4867, 'HYD');
export const bengaluru = place('p2', 'Bengaluru', 12.9716, 77.5946, 'BLR');

export function intent(overrides: Partial<TripIntent> = {}): TripIntent {
  return {
    originQuery: 'Hyderabad',
    destinationQuery: 'Bengaluru',
    departureDate: '2030-11-10',
    returnDate: '2030-11-14',
    travelers: { adults: 2, children: 0, infants: 0 },
    currency: 'INR',
    origin: hyderabad,
    destination: bengaluru,
    ...overrides,
  };
}

export function profile(overrides: Partial<TravelerProfile> = {}): TravelerProfile {
  return { ...emptyTravelerProfile(), ...overrides };
}

export function constraintsFor(
  p: TravelerProfile,
  tripIntent: TripIntent = intent(),
  budget: { total: number | null; firm?: boolean } = { total: null },
) {
  return buildConstraints(tripIntent, p, {
    total: budget.total === null ? null : money(budget.total, 'INR'),
    transport: null,
    accommodation: null,
    dailySpendPerPerson: null,
    firm: budget.firm ?? false,
  });
}

export const classificationFor = (tripIntent: TripIntent = intent()) =>
  classifyJourney(tripIntent.origin, tripIntent.destination);

// -------------------------------------------------------------- providers

const provenance = {
  provider: 'fake-travel',
  providerLabel: 'Fake travel',
  retrievedAt: '2026-01-01T00:00:00.000Z',
  validUntil: null,
  searchId: null,
  attribution: null,
};

const two = (n: number) => String(n).padStart(2, '0');

export function flightOn(date: string, fromCode: string, toCode: string, hour: number, id: string, rupees = 9_600): TransportOffer {
  return {
    id,
    mode: 'flight',
    segments: [
      {
        mode: 'flight',
        operatorCode: '6E',
        operatorName: 'IndiGo',
        serviceNumber: '6E123',
        origin: { code: fromCode, name: fromCode, coordinates: null, timezone: 'Asia/Kolkata', terminal: '1' },
        destination: { code: toCode, name: toCode, coordinates: null, timezone: 'Asia/Kolkata', terminal: '2' },
        departureAt: `${date}T${two(hour)}:00:00`,
        arrivalAt: `${date}T${two(hour + 1)}:15:00`,
        durationMinutes: 75,
        vehicleType: '320',
      },
    ],
    totalPrice: money(rupees, 'INR'),
    pricePerTraveler: money(rupees / 2, 'INR'),
    itemisedFees: [],
    unpricedCosts: [],
    fareClasses: [
      {
        code: 'Y', label: 'Economy', cabin: 'economy', price: money(rupees, 'INR'), availability: 4,
        availabilityLabel: '4 seat(s) bookable at this fare', refundable: false, checkedBagsIncluded: 1, cabinBagKg: 7,
      },
    ],
    selectedFareCode: 'Y',
    totalDurationMinutes: 75,
    transfers: 0,
    overnight: false,
    refundable: false,
    cancellationPolicy: null,
    baggageSummary: '1 checked bag(s) included per traveller',
    revalidationToken: 'tok',
    provenance,
  };
}

export function hotelOffer(id: string, name: string, category: number, totalRupees: number, nights = 4): HotelOffer {
  return {
    id, name, propertyType: null, category, guestRating: null, guestRatingCount: null,
    coordinates: { lat: 12.9716, lon: 77.5946 }, address: null, neighbourhood: null, amenities: [],
    checkInTime: null, checkOutTime: null,
    rooms: [
      {
        id: `${id}-room`, description: 'Double room', roomType: null, beds: null, maxOccupancy: 2, boardType: null,
        breakfastIncluded: false, refundable: true, cancellationDeadline: null, cancellationPolicy: null,
        totalPrice: money(totalRupees, 'INR'), pricePerNight: money(totalRupees / nights, 'INR'),
        taxesIncluded: null, revalidationToken: 'tok',
      },
    ],
    images: [],
    provenance,
  };
}

export interface Fake {
  registry: ProviderRegistry;
  calls: { flights: number; hotels: number };
}

/** A registry that answers from memory: one flight each way, and two hotels. */
export function fakeTravel(): Fake {
  const registry = new ProviderRegistry(loadProvidersEnv({}));
  const calls = { flights: 0, hotels: 0 };
  registry.flights.push({
    descriptor: { id: 'fake-flights', label: 'Fake flights', kinds: ['flight'], requiredEnv: [], coverage: 'global', docsUrl: null, attribution: null },
    isConfigured: () => true,
    health: async () => ok({ ok: true as const, latencyMs: 1 }, provenance),
    searchFlights: async (req: { origin: { name: string }; departureDate: string }) => {
      calls.flights += 1;
      const homeward = req.origin.name === 'Bengaluru';
      const offer = homeward
        ? flightOn(req.departureDate, 'BLR', 'HYD', 16, `ret-${req.departureDate}`)
        : flightOn(req.departureDate, 'HYD', 'BLR', 8, `out-${req.departureDate}`);
      return ok([offer], provenance);
    },
    revalidateFlight: async () => { throw new Error('not used'); },
  } as never);
  registry.hotels.push({
    descriptor: { id: 'fake-hotels', label: 'Fake hotels', kinds: ['hotel'], requiredEnv: [], coverage: 'global', docsUrl: null, attribution: null },
    isConfigured: () => true,
    health: async () => ok({ ok: true as const, latencyMs: 1 }, provenance),
    searchHotels: async (req: { checkIn: string; checkOut: string }) => {
      calls.hotels += 1;
      const nights = Math.max(1, Math.round((Date.parse(req.checkOut) - Date.parse(req.checkIn)) / 86_400_000));
      return ok(
        [hotelOffer('h-simple', 'Simple Stay', 3, 6_000 * nights, nights), hotelOffer('h-grand', 'Grand Stay', 5, 14_000 * nights, nights)],
        provenance,
      );
    },
    revalidateHotel: async () => { throw new Error('not used'); },
  } as never);
  return { registry, calls };
}

/** Plans built by the real engine from the offline providers, for tests that need genuine plans to break. */
export async function realPlans(
  options: {
    intent?: TripIntent;
    profile?: TravelerProfile;
    budget?: { total: number | null; firm?: boolean };
    keep?: import('@trip/engine').KeptComponents;
    fake?: Fake;
  } = {},
) {
  const { generatePlans } = await import('@trip/engine');
  const tripIntent = options.intent ?? intent();
  const p = options.profile ?? profile({ priorities: ['cheapest'] });
  const constraints = constraintsFor(p, tripIntent, options.budget ?? { total: null });
  const fake = options.fake ?? fakeTravel();
  const result = await generatePlans({
    registry: fake.registry,
    intent: tripIntent,
    profile: p,
    constraints,
    ...(options.keep ? { keep: options.keep } : {}),
  });
  return { result, plans: result.plans, intent: tripIntent, profile: p, constraints, fake };
}

/** A drive in the traveller's own car: a real ₹0 fare, with its distance and time, and costs that cannot be priced named. */
export function driveOffer(date: string, fromCode: string, toCode: string, leaveHour = 6): TransportOffer {
  return {
    ...flightOn(date, fromCode, toCode, leaveHour, `drive-${fromCode}-${date}`),
    mode: 'self_drive',
    segments: [
      {
        mode: 'self_drive',
        operatorCode: null,
        operatorName: 'Your own car',
        serviceNumber: null,
        origin: { code: fromCode, name: fromCode, coordinates: null, timezone: 'Asia/Kolkata', terminal: null },
        destination: { code: toCode, name: toCode, coordinates: null, timezone: 'Asia/Kolkata', terminal: null },
        departureAt: `${date}T${two(leaveHour)}:00:00`,
        arrivalAt: `${date}T${two(leaveHour + 8)}:00:00`,
        durationMinutes: 480,
        vehicleType: null,
      },
    ],
    totalPrice: money(0, 'INR'),
    pricePerTraveler: money(0, 'INR'),
    itemisedFees: [
      { label: 'Fuel (estimate)', amount: money(3_000, 'INR'), included: false, isEstimate: true, basis: 'distance and the configured vehicle profile' },
    ],
    unpricedCosts: ['Tolls and parking'],
    fareClasses: [],
    selectedFareCode: null,
    totalDurationMinutes: 480,
    revalidationToken: null,
  } as unknown as TransportOffer;
}
