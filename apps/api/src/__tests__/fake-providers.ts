import { ProviderRegistry, loadProvidersEnv } from '@trip/providers';
import { money, ok, type HotelOffer, type TransportOffer } from '@trip/shared';
import { fakeGeocoder } from './helpers.js';

/**
 * Travel providers that answer from memory, so the API can build real plans
 * with the real engine and no network: one flight each way, and two hotels.
 * Every offer carries a revalidation token, so tests can check that none of
 * them ever reaches a browser.
 */

export const SECRET_TOKEN = 'SECRET-REVALIDATION-TOKEN';

const provenance = {
  provider: 'fake-travel',
  providerLabel: 'Fake travel',
  retrievedAt: '2026-01-01T00:00:00.000Z',
  validUntil: null,
  searchId: null,
  attribution: null,
};

export function flightOn(date: string, fromCode: string, toCode: string, hour: number, id: string): TransportOffer {
  const two = (n: number) => String(n).padStart(2, '0');
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
    totalPrice: money(9_600, 'INR'),
    pricePerTraveler: money(4_800, 'INR'),
    itemisedFees: [],
    unpricedCosts: [],
    fareClasses: [
      {
        code: 'Y',
        label: 'Economy',
        cabin: 'economy',
        price: money(9_600, 'INR'),
        availability: 4,
        availabilityLabel: '4 seat(s) bookable at this fare',
        refundable: false,
        checkedBagsIncluded: 1,
        cabinBagKg: 7,
      },
    ],
    selectedFareCode: 'Y',
    totalDurationMinutes: 75,
    transfers: 0,
    overnight: false,
    refundable: false,
    cancellationPolicy: null,
    baggageSummary: '1 checked bag(s) included per traveller',
    revalidationToken: SECRET_TOKEN,
    provenance,
  };
}

export function hotelOffer(id: string, name: string, category: number, totalRupees: number, nights = 4): HotelOffer {
  return {
    id,
    name,
    propertyType: null,
    category,
    guestRating: null,
    guestRatingCount: null,
    coordinates: { lat: 12.9716, lon: 77.5946 },
    address: null,
    neighbourhood: null,
    amenities: [],
    checkInTime: null,
    checkOutTime: null,
    rooms: [
      {
        id: `${id}-room`,
        description: 'Double room',
        roomType: null,
        beds: null,
        maxOccupancy: 2,
        boardType: null,
        breakfastIncluded: null,
        refundable: true,
        cancellationDeadline: null,
        cancellationPolicy: null,
        totalPrice: money(totalRupees, 'INR'),
        pricePerNight: money(totalRupees / nights, 'INR'),
        taxesIncluded: null,
        revalidationToken: SECRET_TOKEN,
      },
    ],
    images: [],
    provenance,
  };
}

export type FlightSearchStub = (req: {
  origin: { name: string };
  departureDate: string;
  signal?: AbortSignal;
}) => Promise<unknown>;

export interface FakeTravel {
  registry: ProviderRegistry;
  /** How many times each kind of search was made, to see what a re-plan reused. */
  calls: { flights: number; hotels: number };
  /** What the things-to-do search was asked for, when `activities` was requested. */
  activityRequests: Array<{ categories: string[]; limit: number }>;
}

export function fakeTravelRegistry(
  options: {
    /** Replaces the flight search, for tests about slow or failing providers. */
    flights?: FlightSearchStub;
    /** Adds a things-to-do provider that finds nothing but records what it was asked for. */
    activities?: boolean;
  } = {},
): FakeTravel {
  const registry = new ProviderRegistry(loadProvidersEnv({}));
  const calls = { flights: 0, hotels: 0 };
  const activityRequests: FakeTravel['activityRequests'] = [];

  registry.geocoding.push(fakeGeocoder as never);

  const defaultFlights = async (req: { origin: { name: string }; departureDate: string }) => {
    const homeward = req.origin.name === 'Bengaluru';
    const offer = homeward
      ? flightOn(req.departureDate, 'BLR', 'HYD', 16, `ret-${req.departureDate}`)
      : flightOn(req.departureDate, 'HYD', 'BLR', 8, `out-${req.departureDate}`);
    return ok([offer], offer.provenance);
  };
  registry.flights.push({
    descriptor: { id: 'fake-flights', label: 'Fake flights', kinds: ['flight'], requiredEnv: [], coverage: 'global', docsUrl: null, attribution: null },
    isConfigured: () => true,
    health: async () => ok({ ok: true as const, latencyMs: 1 }, provenance),
    searchFlights: async (req: never) => {
      calls.flights += 1;
      return (options.flights ?? defaultFlights)(req) as never;
    },
    revalidateFlight: async () => {
      throw new Error('not used');
    },
  } as never);

  registry.hotels.push({
    descriptor: { id: 'fake-hotels', label: 'Fake hotels', kinds: ['hotel'], requiredEnv: [], coverage: 'global', docsUrl: null, attribution: null },
    isConfigured: () => true,
    health: async () => ok({ ok: true as const, latencyMs: 1 }, provenance),
    searchHotels: async (req: { checkIn: string; checkOut: string }) => {
      calls.hotels += 1;
      const nights = Math.max(1, Math.round((Date.parse(req.checkOut) - Date.parse(req.checkIn)) / 86_400_000));
      const offers = [
        hotelOffer('h-simple', 'Simple Stay', 3, 6_000 * nights, nights),
        hotelOffer('h-grand', 'Grand Stay', 5, 14_000 * nights, nights),
      ];
      return ok(offers, provenance) as never;
    },
    revalidateHotel: async () => {
      throw new Error('not used');
    },
  } as never);

  if (options.activities) {
    registry.activities.push({
      descriptor: { id: 'fake-activities', label: 'Fake activities', kinds: ['activity'], requiredEnv: [], coverage: 'global', docsUrl: null, attribution: null },
      isConfigured: () => true,
      health: async () => ok({ ok: true as const, latencyMs: 1 }, provenance),
      searchActivities: async (req: { categories: string[]; limit: number }) => {
        activityRequests.push({ categories: req.categories, limit: req.limit });
        return ok([], provenance) as never;
      },
    } as never);
  }

  return { registry, calls, activityRequests };
}
