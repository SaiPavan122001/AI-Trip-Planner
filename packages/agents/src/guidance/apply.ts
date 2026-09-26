import type { ActivityGuidance } from '@trip/engine';
import type { StayArea, TravelerProfile } from '@trip/shared';
import type { AccommodationGuidance } from './accommodation.js';
import type { ActivityAgentGuidance } from './activity.js';
import type { TransportGuidance } from './transport.js';

/** What the three guidance agents concluded. Any part may be absent: an agent may have failed. */
export interface PlanGuidance {
  transport: TransportGuidance | null;
  accommodation: AccommodationGuidance | null;
  activities: ActivityAgentGuidance | null;
}

export const noGuidance = (): PlanGuidance => ({ transport: null, accommodation: null, activities: null });

/** What each area means to the hotel ranking, as a fixed sentence. Never model-written. */
const AREA_PHRASE: Record<StayArea, string> = {
  near_activities: 'close to the places you plan to visit',
  central: 'in a central area',
  quiet: 'in a quiet area',
  near_transport: 'near the station or airport',
};

export interface AppliedGuidance {
  profile: TravelerProfile;
  activityGuidance: ActivityGuidance;
  /** What changed, in words, for the trace. */
  applied: string[];
  /** What was proposed but could not be used, and why. */
  notApplied: string[];
}

/**
 * Lets guidance fill gaps in a profile, and nothing else.
 *
 * The rule is simple and is the point: **an agent fills what the traveller left
 * empty; it never overwrites what they answered**, and it never touches a hard
 * requirement (excluded modes, accessibility, minimum category, room count,
 * time windows), the priority ranking, or the budget. Guidance can only move
 * soft preferences, so at worst a poor suggestion changes an ordering.
 */
export function applyGuidance(profile: TravelerProfile, guidance: PlanGuidance): AppliedGuidance {
  const next = structuredClone(profile);
  const applied: string[] = [];
  const notApplied: string[] = [];

  const transport = guidance.transport;
  if (transport?.preferredMode) {
    if (next.transport.preferredMode === null) {
      next.transport.preferredMode = transport.preferredMode;
      applied.push(`Favouring ${transport.preferredMode.replace('_', ' ')}, as the traveller said.`);
    } else {
      notApplied.push('A preferred way of travelling was already set, so it was left as it was.');
    }
  }

  const stay = guidance.accommodation;
  if (stay?.area) {
    if (next.accommodation.locationPreference === null) {
      next.accommodation.locationPreference = AREA_PHRASE[stay.area];
      applied.push(`Preferring a stay ${AREA_PHRASE[stay.area]}.`);
    } else {
      notApplied.push('A location preference was already set, so it was left as it was.');
    }
  }
  if (stay?.breakfast) {
    if (next.accommodation.breakfastIncluded === null) {
      next.accommodation.breakfastIncluded = true;
      applied.push('Preferring breakfast included.');
    } else {
      notApplied.push('A breakfast preference was already set, so it was left as it was.');
    }
  }
  for (const amenity of stay?.amenities ?? []) {
    if (amenity !== 'breakfast') notApplied.push(`${amenity.replace('_', ' ')}: noted, but nothing here scores or filters on it yet.`);
  }

  const activities = guidance.activities;
  const activityGuidance: ActivityGuidance = {
    ...(activities && activities.interests.length > 0 ? { interests: activities.interests } : {}),
    ...(activities?.pace ? { pace: activities.pace } : {}),
  };
  if (activityGuidance.interests) applied.push(`Looking for things to do around: ${activityGuidance.interests.join(', ')}.`);
  if (activityGuidance.pace) applied.push(`Planning a ${activityGuidance.pace} pace.`);

  return { profile: next, activityGuidance, applied, notApplied };
}
