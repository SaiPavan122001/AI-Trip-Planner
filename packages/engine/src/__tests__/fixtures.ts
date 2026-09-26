import {
  money,
  type ConstraintSet,
  type HotelOffer,
  type Place,
  type TransportOffer,
  type TravelerProfile,
  type TripIntent,
} from '@trip/shared';
import { emptyTravelerProfile } from '@trip/shared';
import { buildConstraints } from '../constraints.js';

/** Shared fixtures. Real coordinates and timezones, so scheduling tests
 *  exercise genuine offsets rather than a convenient fiction. */

export const hyderabad: Place = {
  id: 'test:hyd',
  name: 'Hyderabad',
  displayName: 'Hyderabad, Telangana, India',
  coordinates: { lat: 17.385, lon: 78.4867 },
  countryCode: 'IN',
  countryName: 'India',
  region: 'Telangana',
  timezone: 'Asia/Kolkata',
  airports: [{ iataCode: 'HYD', name: 'Rajiv Gandhi Intl', distanceKm: 24, coordinates: null }],
  source: 'test',
  resolvedAt: '2026-01-01T00:00:00.000Z',
};

export const bengaluru: Place = {
  ...hyderabad,
  id: 'test:blr',
  name: 'Bengaluru',
  displayName: 'Bengaluru, Karnataka, India',
  coordinates: { lat: 12.9716, lon: 77.5946 },
  region: 'Karnataka',
  airports: [{ iataCode: 'BLR', name: 'Kempegowda Intl', distanceKm: 35, coordinates: null }],
};

export const paris: Place = {
  id: 'test:par',
  name: 'Paris',
  displayName: 'Paris, Île-de-France, France',
  coordinates: { lat: 48.8566, lon: 2.3522 },
  countryCode: 'FR',
  countryName: 'France',
  timezone: 'Europe/Paris',
  airports: [{ iataCode: 'CDG', name: 'Charles de Gaulle', distanceKm: 27, coordinates: null }],
  source: 'test',
  resolvedAt: '2026-01-01T00:00:00.000Z',
};

export const london: Place = {
  ...paris,
  id: 'test:lon',
  name: 'London',
  displayName: 'London, England, United Kingdom',
  coordinates: { lat: 51.5072, lon: -0.1276 },
  countryCode: 'GB',
  countryName: 'United Kingdom',
  timezone: 'Europe/London',
  airports: [{ iataCode: 'LHR', name: 'Heathrow', distanceKm: 23, coordinates: null }],
};

export function intent(overrides: Partial<TripIntent> = {}): TripIntent {
  return {
    originQuery: 'Hyderabad',
    destinationQuery: 'Bengaluru',
    departureDate: '2026-11-10',
    returnDate: '2026-11-14',
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

export function transportOffer(overrides: Partial<TransportOffer> = {}): TransportOffer {
  const base: TransportOffer = {
    id: 'test-offer',
    mode: 'flight',
    segments: [
      {
        mode: 'flight',
        operatorCode: '6E',
        operatorName: 'IndiGo',
        serviceNumber: '6E123',
        origin: {
          code: 'HYD',
          name: 'HYD',
          coordinates: null,
          timezone: 'Asia/Kolkata',
          terminal: '1',
        },
        destination: {
          code: 'BLR',
          name: 'BLR',
          coordinates: null,
          timezone: 'Asia/Kolkata',
          terminal: '2',
        },
        departureAt: '2026-11-10T08:00:00',
        arrivalAt: '2026-11-10T09:15:00',
        durationMinutes: 75,
        vehicleType: '320',
      },
    ],
    totalPrice: money(9600, 'INR'),
    pricePerTraveler: money(4800, 'INR'),
    itemisedFees: [],
    unpricedCosts: [],
    fareClasses: [
      {
        code: 'Y',
        label: 'Economy',
        cabin: 'economy',
        price: money(9600, 'INR'),
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
    revalidationToken: null,
    provenance: {
      provider: 'test',
      providerLabel: 'Test provider',
      retrievedAt: '2026-01-01T00:00:00.000Z',
      validUntil: null,
      searchId: null,
      attribution: null,
    },
  };
  return { ...base, ...overrides };
}

export function hotel(overrides: Partial<HotelOffer> = {}): HotelOffer {
  const provenance = {
    provider: 'test',
    providerLabel: 'Test provider',
    retrievedAt: '2026-01-01T00:00:00.000Z',
    validUntil: null,
    searchId: null,
    attribution: null,
  };
  return {
    id: 'test-hotel',
    name: 'Test Hotel',
    propertyType: null,
    category: 4,
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
        id: 'room-1',
        description: 'Double room',
        roomType: null,
        beds: null,
        maxOccupancy: 2,
        boardType: null,
        breakfastIncluded: null,
        refundable: true,
        cancellationDeadline: null,
        cancellationPolicy: null,
        totalPrice: money(24000, 'INR'),
        pricePerNight: money(6000, 'INR'),
        taxesIncluded: null,
        revalidationToken: null,
      },
    ],
    images: [],
    provenance,
    ...overrides,
  };
}

/** The constraint set a profile implies for the default trip, with no budget. */
export function buildConstraintsOnly(p: TravelerProfile, tripIntent: TripIntent = intent()): ConstraintSet {
  return buildConstraints(tripIntent, p, {
    total: null,
    transport: null,
    accommodation: null,
    dailySpendPerPerson: null,
  });
}
