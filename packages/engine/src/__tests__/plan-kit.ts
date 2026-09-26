import {
  emptyTravelerProfile,
  money,
  type ConstraintSet,
  type HotelOffer,
  type HotelRoomOffer,
  type TransportOffer,
  type TravelerProfile,
  type TripIntent,
} from '@trip/shared';
import { buildConstraints, type BudgetAnswers } from '../constraints.js';
import { generatePlans, type PlanGenerationDeps } from '../plans.js';
import { hotel, intent as baseIntent, transportOffer } from './fixtures.js';
import { answers, flightProvider, hotelProvider, registryWith, type RegistryParts } from './kit.js';

/**
 * Trip-level fixtures for the planner's decisions: a handful of realistic
 * journeys and rooms, and one call that plans a trip from them with nothing
 * on the network. Dates are in the future of the test clock, and every time is
 * a wall-clock time in India.
 */

const two = (n: number) => String(n).padStart(2, '0');
const at = (date: string, minutesFromMidnight: number) =>
  `${date}T${two(Math.floor(minutesFromMidnight / 60) % 24)}:${two(minutesFromMidnight % 60)}:00`;

export interface JourneySpec {
  id: string;
  /** Total fare for the party, in rupees. */
  rupees: number;
  /** Departure, minutes past midnight. */
  departs: number;
  minutes: number;
  transfers?: number;
  refundable?: boolean;
  overnight?: boolean;
  /** Extra fare classes, to give a comfort score something to read. */
  cabin?: 'economy' | 'premium_economy' | 'business';
}

/** A flight on `date` from `from` to `to`, arriving `minutes` after it leaves (through midnight if need be). */
export function journey(spec: JourneySpec, date: string, from = 'HYD', to = 'BLR'): TransportOffer {
  const base = transportOffer();
  const arrives = spec.departs + spec.minutes;
  const arrivalDate = arrives >= 24 * 60 ? new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : date;
  return {
    ...base,
    id: `${spec.id}-${date}`,
    totalPrice: money(spec.rupees, 'INR'),
    pricePerTraveler: money(spec.rupees / 2, 'INR'),
    segments: [
      {
        ...base.segments[0]!,
        origin: { ...base.segments[0]!.origin, code: from },
        destination: { ...base.segments[0]!.destination, code: to },
        departureAt: at(date, spec.departs),
        arrivalAt: at(arrivalDate, arrives % (24 * 60)),
        durationMinutes: spec.minutes,
      },
    ],
    totalDurationMinutes: spec.minutes,
    transfers: spec.transfers ?? 0,
    refundable: spec.refundable ?? false,
    overnight: spec.overnight ?? false,
    fareClasses: base.fareClasses.map((f) => ({ ...f, cabin: spec.cabin ?? 'economy', price: money(spec.rupees, 'INR') })),
  };
}

/** The same journey by rail or coach: the mode is on the offer and on each of its legs. */
export function surface(mode: 'train' | 'bus', spec: JourneySpec, date: string): TransportOffer {
  const offer = journey(spec, date);
  return { ...offer, mode, segments: offer.segments.map((seg) => ({ ...seg, mode })) };
}

export const room = (id: string, rupees: number, over: Partial<HotelRoomOffer> = {}): HotelRoomOffer => ({
  ...hotel().rooms[0]!,
  id,
  description: `Room ${id}`,
  totalPrice: money(rupees, 'INR'),
  pricePerNight: money(rupees / 4, 'INR'),
  ...over,
});

export const property = (id: string, category: number, rooms: HotelRoomOffer[], lat = 12.9716): HotelOffer =>
  hotel({ id, name: `Hotel ${id}`, category, coordinates: { lat, lon: 77.5946 }, rooms });

export interface TripSpec {
  /** Outward and return journeys on offer. */
  out?: JourneySpec[];
  back?: JourneySpec[];
  stays?: HotelOffer[];
  profile?: Partial<TravelerProfile>;
  intent?: Partial<TripIntent>;
  budget?: Partial<BudgetAnswers>;
  parts?: RegistryParts;
  keep?: PlanGenerationDeps['keep'];
  signal?: AbortSignal;
}

export const DEFAULT_OUT: JourneySpec[] = [{ id: 'out-a', rupees: 9_600, departs: 8 * 60, minutes: 75 }];
export const DEFAULT_BACK: JourneySpec[] = [{ id: 'back-a', rupees: 9_600, departs: 16 * 60, minutes: 75 }];

/** Plans a Hyderabad to Bengaluru trip (10 to 14 November) from the options given. */
export async function planTrip(spec: TripSpec = {}) {
  const trip: TripIntent = { ...baseIntent({ returnDate: '2026-11-14' }), ...spec.intent };
  const profile: TravelerProfile = { ...emptyTravelerProfile(), ...spec.profile };
  const constraints: ConstraintSet = buildConstraints(trip, profile, {
    total: null,
    transport: null,
    accommodation: null,
    dailySpendPerPerson: null,
    ...spec.budget,
  });
  const out = spec.out ?? DEFAULT_OUT;
  const back = spec.back ?? DEFAULT_BACK;
  const registry = registryWith({
    flights: [
      flightProvider('flights', async (req: { departureDate: string; origin: { name: string } }) => {
        const homeward = req.origin.name === trip.destination.name;
        return answers.ok((homeward ? back : out).map((s) => journey(s, req.departureDate, homeward ? 'BLR' : 'HYD', homeward ? 'HYD' : 'BLR')));
      }),
    ],
    hotels: [hotelProvider('hotels', async () => answers.ok(spec.stays ?? [property('h-1', 3, [room('r-1', 24_000)])]))],
    ...spec.parts,
  });
  const result = await generatePlans({
    registry,
    intent: trip,
    profile,
    constraints,
    ...(spec.keep ? { keep: spec.keep } : {}),
    ...(spec.signal ? { signal: spec.signal } : {}),
  });
  return { ...result, intent: trip, profile, constraints };
}

export const planOf = (plans: Awaited<ReturnType<typeof planTrip>>['plans'], archetype: string) =>
  plans.find((p) => p.archetype === archetype);
