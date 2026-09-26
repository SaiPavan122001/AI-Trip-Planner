import { z } from 'zod';
import { Place } from './geo.js';
import { SUPPORTED_CURRENCY } from './money.js';

/** ISO date, no time component: the traveller thinks in dates, not instants. */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export type IsoDate = z.infer<typeof IsoDate>;

/**
 * Step 1 of the funnel. Deliberately minimal: nothing else may be asked before
 * these five facts exist, because every later question depends on them.
 */
export const TripIntentInput = z.object({
  originQuery: z.string().min(1),
  destinationQuery: z.string().min(1),
  departureDate: IsoDate,
  returnDate: IsoDate.nullable().default(null),
  travelers: z.object({
    adults: z.number().int().min(1).max(20),
    children: z.number().int().min(0).max(20).default(0),
    infants: z.number().int().min(0).max(10).default(0),
  }),
  /** Always INR: see SUPPORTED_CURRENCY. Accepted in the request so the API
   *  contract can widen later without changing shape. */
  currency: z
    .literal(SUPPORTED_CURRENCY, {
      errorMap: () => ({ message: 'Trips are planned in Indian rupees (INR).' }),
    })
    .default(SUPPORTED_CURRENCY),
});
export type TripIntentInput = z.infer<typeof TripIntentInput>;

export const TripIntent = TripIntentInput.extend({
  origin: Place,
  destination: Place,
});
export type TripIntent = z.infer<typeof TripIntent>;

export const JourneyScope = z.enum(['domestic', 'international']);
export type JourneyScope = z.infer<typeof JourneyScope>;

export const TransportMode = z.enum([
  'flight',
  'train',
  'bus',
  'self_drive',
  'rental_car',
  'taxi',
  'ferry',
]);
export type TransportMode = z.infer<typeof TransportMode>;

/**
 * Output of journey classification. `eligibleModes` is the authoritative list of
 * what the UI may offer. Modes are excluded with a stated reason rather than
 * silently dropped, so the traveller can see why "train" is not on the table
 * for Hyderabad to Paris.
 */
export const JourneyClassification = z.object({
  scope: JourneyScope,
  originCountry: z.string().length(2),
  destinationCountry: z.string().length(2),
  greatCircleKm: z.number(),
  crossesTimezones: z.boolean(),
  originTimezone: z.string(),
  destinationTimezone: z.string(),
  /** Whether a surface route plausibly exists (same landmass, linked by road or rail). */
  surfaceRoutePlausible: z.boolean(),
  eligibleModes: z.array(TransportMode),
  excludedModes: z.array(z.object({ mode: TransportMode, reason: z.string() })),
  /** Documentation the traveller likely needs. Advisory only, never legal advice. */
  documentationNotes: z.array(z.string()).default([]),
});
export type JourneyClassification = z.infer<typeof JourneyClassification>;

export function nightsBetween(departure: IsoDate, ret: IsoDate | null): number {
  if (!ret) return 0;
  const a = Date.parse(`${departure}T00:00:00Z`);
  const b = Date.parse(`${ret}T00:00:00Z`);
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

export function totalTravelers(t: TripIntentInput['travelers']): number {
  return t.adults + t.children + t.infants;
}

/** Lap infants are generally not counted for hotel occupancy or most seats. */
export function seatedTravelers(t: TripIntentInput['travelers']): number {
  return t.adults + t.children;
}
