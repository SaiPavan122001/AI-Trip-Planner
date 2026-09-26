import {
  ModificationRequest,
  multiply,
  type ConstraintSet,
  type TravelerProfile,
  type TripIntent,
} from '@trip/shared';

/**
 * Conversational modification, applied deterministically.
 *
 * The AI layer's job is to turn "make it cheaper, but keep the hotel" into a
 * `ModificationRequest`. This module's job is to apply that request to the
 * profile and constraints, decide what must be re-searched, and refuse
 * anything that would breach a hard constraint without consent.
 *
 * The split matters: a model that could edit constraints directly could talk
 * itself into a plan that violates the traveller's budget. Here it can only
 * name an intent, and the rules for each intent are written down.
 */

export interface ModificationOutcome {
  profile: TravelerProfile;
  constraints: ConstraintSet;
  /** Components whose searches must be re-run. */
  reSearch: Array<'outbound' | 'return' | 'hotel' | 'transfers' | 'activities'>;
  /** Components carried over untouched because the traveller pinned them. */
  preserved: Array<'outbound' | 'return' | 'hotel' | 'transfers' | 'activities'>;
  /** Plain-language description of what changed, shown before re-planning. */
  summary: string;
  /** Set when the request cannot be honoured without relaxing a hard rule. */
  requiresConsent: { constraint: string; question: string } | null;
}

const ALL_COMPONENTS = ['outbound', 'return', 'hotel', 'transfers', 'activities'] as const;

export function applyModification(
  proposed: ModificationRequest,
  intent: TripIntent,
  profile: TravelerProfile,
  constraints: ConstraintSet,
): ModificationOutcome {
  // The request usually comes from a language model. It has been validated
  // where it was produced, and is validated again here, at the boundary of
  // the code that changes the trip, so this function never depends on every
  // caller having remembered.
  const request = ModificationRequest.parse(proposed);
  const nextProfile: TravelerProfile = structuredClone(profile);
  const nextConstraints: ConstraintSet = structuredClone(constraints);
  const pinned = new Set(request.pinnedComponents);
  let summary: string;
  let requiresConsent: ModificationOutcome['requiresConsent'] = null;
  let reSearch: Array<(typeof ALL_COMPONENTS)[number]> = [];

  switch (request.intent) {
    case 'reduce_cost': {
      // Cost pressure is expressed by re-ranking, not by secretly lowering
      // standards: "cheapest" moves to the front and the search runs again.
      nextProfile.priorities = ['cheapest', ...profile.priorities.filter((p) => p !== 'cheapest')];
      reSearch = ['outbound', 'return', 'hotel'];
      summary = 'Price is now the first thing the planner optimises for; everything else follows it.';
      break;
    }
    case 'increase_comfort': {
      nextProfile.priorities = [
        'most_comfortable',
        ...profile.priorities.filter((p) => p !== 'most_comfortable'),
      ];
      if (nextProfile.accommodation.minCategory !== null) {
        nextProfile.accommodation.minCategory = Math.min(5, nextProfile.accommodation.minCategory + 1);
      }
      reSearch = ['outbound', 'return', 'hotel'];
      summary = 'Comfort now leads the ranking, and the minimum property standard has gone up a step.';
      if (constraints.budget.total) {
        requiresConsent = {
          constraint: 'max_total_budget',
          question:
            'A more comfortable plan will probably cost more than your stated budget. May the planner show options above it?',
        };
      }
      break;
    }
    case 'change_transport_mode': {
      const mode = request.parameters.mode;
      if (!mode) {
        summary = 'No transport mode was identified in that request.';
        break;
      }
      // Asking for a train means dropping any earlier exclusion of trains.
      nextProfile.transport.excludedModes = profile.transport.excludedModes.filter((m) => m !== mode);
      nextConstraints.hard = nextConstraints.hard.filter(
        (c) => !(c.kind === 'excluded_transport_mode' && c.value === mode),
      );
      (nextProfile as { preferredMode?: string }).preferredMode = mode;
      reSearch = ['outbound', 'return', 'transfers'];
      summary = `The journey will be re-planned around ${mode.replace('_', ' ')} where a provider can actually sell it.`;
      break;
    }
    case 'change_hotel_tier': {
      const target = request.parameters.category;
      if (target !== undefined) {
        nextProfile.accommodation.minCategory = Math.max(0, Math.min(5, target));
        summary = `Only properties rated ${nextProfile.accommodation.minCategory} or above will be considered.`;
      } else {
        summary = 'No star rating was identified in that request.';
      }
      reSearch = ['hotel'];
      break;
    }
    case 'avoid_overnight': {
      nextProfile.transport.avoidOvernightTravel = true;
      reSearch = ['outbound', 'return'];
      summary = 'Overnight legs are now avoided. Daytime departures usually cost more or take longer.';
      break;
    }
    case 'shift_departure_time': {
      const earliest = request.parameters.earliestDeparture;
      const latest = request.parameters.latestArrival;
      if (earliest) nextProfile.transport.earliestDepartureLocal = earliest;
      if (latest) nextProfile.transport.latestArrivalLocal = latest;
      reSearch = ['outbound', 'transfers'];
      summary = `Departure window updated${earliest ? ` to depart no earlier than ${earliest}` : ''}.`;
      break;
    }
    case 'change_party_size': {
      // Party size is a hard constraint on the intent itself, so this is
      // handed back to the caller rather than applied here: every search,
      // including occupancy and fares, has to start again.
      reSearch = [...ALL_COMPONENTS];
      summary =
        'The number of travellers has changed, so fares, room occupancy and transfers all have to be searched again.';
      requiresConsent = {
        constraint: 'traveler_count',
        question:
          'Changing the party size invalidates every quoted price. Re-run the whole search with the new party?',
      };
      break;
    }
    case 'change_dates': {
      reSearch = [...ALL_COMPONENTS];
      summary = 'New dates mean every price and schedule has to be fetched again.';
      requiresConsent = {
        constraint: 'fixed_departure_date',
        question: 'Confirm the new dates and the planner will search again from scratch.',
      };
      break;
    }
    case 'reprioritise': {
      const order = request.parameters.priorities;
      if (order && order.length > 0) {
        nextProfile.priorities = order;
        summary = `Priorities are now: ${order.join(' before ')}.`;
        reSearch = ['outbound', 'return', 'hotel'];
      } else {
        summary = 'No new priority order was identified in that request.';
      }
      break;
    }
    case 'replace_component': {
      const component = request.parameters.component;
      if (component) {
        reSearch = [component];
        summary = `Only the ${component} will be searched again; everything else is kept exactly as it is.`;
      } else {
        summary = 'It was not clear which part of the plan should be replaced.';
      }
      break;
    }
    case 'add_activity':
    case 'remove_activity': {
      reSearch = ['activities'];
      summary =
        request.intent === 'add_activity'
          ? 'The day plan will be rebuilt to fit the extra stop, and the planner will say if it no longer fits.'
          : 'That stop comes out and the day is re-timed around the gap.';
      break;
    }
    case 'unknown':
    default: {
      summary =
        'That request was not understood well enough to change the plan safely, so nothing has been changed.';
      break;
    }
  }

  // A pinned component is never re-searched, whatever the intent implies.
  const preserved = ALL_COMPONENTS.filter((c) => pinned.has(c));
  const finalReSearch = reSearch.filter((c) => !pinned.has(c));

  if (preserved.length > 0) {
    summary += ` Kept as-is: ${preserved.join(', ')}.`;
  }

  // Re-searching transport changes the arrival time, which changes every
  // transfer built around it, so transfers follow automatically.
  if (finalReSearch.includes('outbound') && !finalReSearch.includes('transfers') && !pinned.has('transfers')) {
    finalReSearch.push('transfers');
  }

  void intent;
  void multiply;

  return {
    profile: nextProfile,
    constraints: nextConstraints,
    reSearch: finalReSearch,
    preserved,
    summary,
    requiresConsent,
  };
}

/**
 * Records a traveller's explicit agreement to break one of their own hard
 * constraints. Nothing else in the codebase may add a waiver, and a waiver
 * always carries the reason it was granted.
 */
export function grantWaiver(
  constraints: ConstraintSet,
  kind: ConstraintSet['hard'][number]['kind'],
  reason: string,
): ConstraintSet {
  const next: ConstraintSet = structuredClone(constraints);
  if (!next.waivers.some((w) => w.kind === kind)) {
    next.waivers.push({ kind, waivedAt: new Date().toISOString(), reason });
  }
  return next;
}
