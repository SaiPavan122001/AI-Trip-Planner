import type { ProviderRegistry } from '@trip/providers';
import {
  haversineKm,
  isOk,
  type ActivityOffer,
  type Coordinates,
  type OpeningHours,
  type Place,
  type ProviderNote,
  type TravelerProfile,
} from '@trip/shared';
import { supportedPriceOrUnknown } from './currency.js';
import { localParts } from './time.js';

/**
 * Activity discovery and day clustering.
 *
 * Two things matter here and nowhere else in the planner. First, opening hours
 * are treated as real data with a real absence: an activity whose hours are
 * unpublished is scheduled with a visible "check before you go" note instead
 * of being quietly assumed open. Second, activities are grouped geographically
 * before being assigned to days, because a day that zig-zags across a city is
 * a day mostly spent in transit.
 */

export interface ActivityPlanResult {
  activities: ActivityOffer[];
  /** Activities grouped into one cluster per planned day. */
  clusters: ActivityOffer[][];
  notes: ProviderNote[];
}

/** Assumed visit length by category when the source publishes none. */
const DURATION_BY_CATEGORY: Record<string, number> = {
  museum: 120,
  art_gallery: 90,
  tourist_attraction: 90,
  historical_landmark: 60,
  park: 75,
  zoo: 180,
  aquarium: 120,
  amusement_park: 240,
};

const DEFAULT_DURATION_MINUTES = 90;

export function assumedDuration(activity: ActivityOffer): {
  minutes: number;
  assumed: boolean;
} {
  if (activity.typicalDurationMinutes) {
    return { minutes: activity.typicalDurationMinutes, assumed: false };
  }
  const byCategory = activity.category ? DURATION_BY_CATEGORY[activity.category] : undefined;
  return { minutes: byCategory ?? DEFAULT_DURATION_MINUTES, assumed: true };
}

export async function planActivities(
  registry: ProviderRegistry,
  destination: Place,
  profile: TravelerProfile,
  days: number,
  currency: string,
  signal?: AbortSignal,
): Promise<ActivityPlanResult> {
  const notes: ProviderNote[] = [];
  if (days <= 0) return { activities: [], clusters: [], notes };

  if (registry.activities.length === 0) {
    const missing = registry.missingCapabilityNote('Things to do', ['google-maps']);
    notes.push({
      provider: missing.provider,
      providerLabel: missing.providerLabel,
      status: missing.status,
      message: missing.message,
      occurredAt: missing.occurredAt,
    });
    return { activities: [], clusters: [], notes };
  }

  // Roughly two anchored activities a day, which leaves room for meals, rest
  // and the unplanned wandering that is usually the best part of a trip.
  const target = Math.max(3, days * 2);
  const found: ActivityOffer[] = [];

  for (const provider of registry.activities) {
    const res = await provider.searchActivities({
      destination,
      near: destination.coordinates,
      radiusKm: 12,
      categories: [],
      accessibilityNeeds: profile.special.accessibility,
      currency,
      limit: Math.min(20, target * 2),
      ...(signal ? { signal } : {}),
    });
    if (isOk(res)) {
      for (const activity of res.data) {
        // A foreign entry price becomes unknown; the place is still worth visiting.
        const priced = supportedPriceOrUnknown(activity.price, activity.provenance);
        if (priced.note && !notes.some((n) => n.message === priced.note!.message)) notes.push(priced.note);
        found.push(priced.price === activity.price ? activity : { ...activity, price: null, priceIsEstimate: false });
      }
      for (const warning of res.warnings) {
        notes.push({
          provider: res.provenance.provider,
          providerLabel: res.provenance.providerLabel,
          status: 'ok',
          message: warning,
          occurredAt: res.provenance.retrievedAt,
        });
      }
    } else {
      notes.push({
        provider: res.provider,
        providerLabel: res.providerLabel,
        status: res.status,
        message: res.message,
        occurredAt: res.occurredAt,
      });
    }
  }

  const ranked = rankActivities(found).slice(0, target);
  return { activities: ranked, clusters: clusterByProximity(ranked, days), notes };
}

/**
 * Ranking uses only published signals: rating and how many people rated it.
 * A place with 4.9 from eleven reviews is not better than 4.5 from nine
 * thousand, so the count damps the rating rather than being ignored.
 */
function rankActivities(activities: ActivityOffer[]): ActivityOffer[] {
  const seen = new Set<string>();
  return activities
    .filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    })
    .sort((a, b) => weight(b) - weight(a));
}

function weight(a: ActivityOffer): number {
  const rating = a.rating ?? 0;
  const count = a.ratingCount ?? 0;
  const confidence = Math.min(1, Math.log10(count + 1) / 3);
  return rating * confidence;
}

/**
 * A simple geographic clustering: seed each day with the strongest remaining
 * activity, then fill it with whatever is closest to that seed. This is not
 * a travelling-salesman solution and does not pretend to be; it is enough to
 * keep a day's stops in one part of town, which is what actually matters.
 */
export function clusterByProximity(activities: ActivityOffer[], days: number): ActivityOffer[][] {
  if (days <= 0 || activities.length === 0) return [];
  const clusters: ActivityOffer[][] = Array.from({ length: days }, () => []);
  const remaining = [...activities];
  const perDay = Math.ceil(activities.length / days);

  for (let day = 0; day < days && remaining.length > 0; day += 1) {
    const seed = remaining.shift()!;
    clusters[day]!.push(seed);
    remaining.sort(
      (a, b) =>
        haversineKm(a.coordinates, seed.coordinates) - haversineKm(b.coordinates, seed.coordinates),
    );
    while (clusters[day]!.length < perDay && remaining.length > 0) {
      clusters[day]!.push(remaining.shift()!);
    }
  }
  return clusters;
}

/**
 * Whether an activity is open at an instant, in its own local zone.
 * Returns `null` when the source publishes no hours: unknown is not the same
 * as closed, and the itinerary says so rather than picking a side.
 */
export function isOpenAt(
  activity: ActivityOffer,
  instantUtc: string,
  timeZone: string,
): boolean | null {
  if (!activity.openingHours || activity.openingHours.length === 0) return null;
  const local = localParts(instantUtc, timeZone);
  const today = activity.openingHours.filter((h) => h.weekday === local.weekday);
  if (today.length === 0) return false;
  return today.some((h) => withinWindow(local.time, h));
}

function withinWindow(time: string, hours: OpeningHours): boolean {
  // A window that ends before it starts crosses midnight.
  if (hours.closes < hours.opens) return time >= hours.opens || time <= hours.closes;
  return time >= hours.opens && time <= hours.closes;
}

export function centroidOf(activities: ActivityOffer[], fallback: Coordinates): Coordinates {
  if (activities.length === 0) return fallback;
  const sum = activities.reduce(
    (acc, a) => ({ lat: acc.lat + a.coordinates.lat, lon: acc.lon + a.coordinates.lon }),
    { lat: 0, lon: 0 },
  );
  return { lat: sum.lat / activities.length, lon: sum.lon / activities.length };
}
