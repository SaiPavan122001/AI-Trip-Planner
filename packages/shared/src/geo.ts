import { z } from 'zod';

export const Coordinates = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export type Coordinates = z.infer<typeof Coordinates>;

/**
 * A resolved place. `countryCode` and `timezone` are required because journey
 * classification and schedule validation are impossible without them — a place
 * that cannot be resolved to a country is rejected rather than guessed.
 */
export const Place = z.object({
  id: z.string(),
  name: z.string(),
  /** Human-readable "City, Region, Country". */
  displayName: z.string(),
  coordinates: Coordinates,
  /** ISO 3166-1 alpha-2. */
  countryCode: z.string().length(2),
  countryName: z.string(),
  region: z.string().optional(),
  /** IANA timezone, e.g. "Asia/Kolkata". */
  timezone: z.string(),
  /** IATA city code when the place maps to one, used for flight search. */
  iataCityCode: z.string().length(3).optional(),
  /** Nearby/serving airports, nearest first. Coordinates are present when the
   *  reference-data source published them, and are used to time transfers. */
  airports: z
    .array(
      z.object({
        iataCode: z.string().length(3),
        name: z.string(),
        distanceKm: z.number(),
        coordinates: Coordinates.nullable().default(null),
      }),
    )
    .default([]),
  /** Which adapter resolved this place, for provenance display. */
  source: z.string(),
  resolvedAt: z.string().datetime(),
});
export type Place = z.infer<typeof Place>;

const EARTH_RADIUS_KM = 6371;

export function haversineKm(a: Coordinates, b: Coordinates): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
