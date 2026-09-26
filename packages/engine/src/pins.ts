import type { PlanningSession, TripComponent, TripPlan } from '@trip/shared';

/**
 * Pins are the parts of a plan the traveller asked to keep. A pin is only a
 * promise the planner can keep while the part still fits the trip, so before
 * a search uses one it is checked, and any that no longer fit are released
 * with a reason the traveller is shown rather than silently dropped or, worse,
 * silently kept.
 */

export interface PinCheck {
  keep: TripComponent[];
  released: Array<{ component: TripComponent; reason: string }>;
}

export function selectedPlanOf(session: Pick<PlanningSession, 'plans' | 'selectedPlanId'>): TripPlan | undefined {
  return session.plans.find((p) => p.id === session.selectedPlanId) ?? session.plans[0];
}

/** The parts a plan actually has, so it is known what can be pinned or kept. */
export function componentsOf(plan: TripPlan | undefined): TripComponent[] {
  if (!plan) return [];
  const parts: TripComponent[] = [];
  if (plan.outboundTransport) parts.push('outbound');
  if (plan.returnTransport) parts.push('return');
  if (plan.hotels.length > 0) parts.push('hotel');
  if (plan.transfers.length > 0) parts.push('transfers');
  if (plan.activities.length > 0) parts.push('activities');
  return parts;
}

const dateOf = (iso: string) => iso.slice(0, 10);

/** What a pin check needs of a trip: its dates and group, its plans, and what was pinned. */
export type PinnableTrip = Pick<PlanningSession, 'intent' | 'plans' | 'selectedPlanId' | 'pins'>;

export function checkPins(session: PinnableTrip): PinCheck {
  const plan = selectedPlanOf(session);
  const keep: TripComponent[] = [];
  const released: PinCheck['released'] = [];
  const { intent } = session;

  for (const component of session.pins) {
    const release = (reason: string) => released.push({ component, reason });

    if (!plan) {
      release('There is no plan to keep this from.');
      continue;
    }
    switch (component) {
      case 'transfers':
        release('Transfers are recalculated whenever the journey or hotel changes.');
        break;
      case 'outbound': {
        const first = plan.outboundTransport?.segments[0];
        if (!first) release('The plan has no outbound journey to keep.');
        else if (dateOf(first.departureAt) !== intent.departureDate) {
          release('The outbound journey cannot be kept: it was for the old dates.');
        } else keep.push(component);
        break;
      }
      case 'return': {
        const first = plan.returnTransport?.segments[0];
        if (!first) release('The plan has no return journey to keep.');
        else if (!intent.returnDate || dateOf(first.departureAt) !== intent.returnDate) {
          release('The return journey cannot be kept: it was for the old dates.');
        } else keep.push(component);
        break;
      }
      case 'hotel': {
        const stay = plan.hotels[0];
        const travellers = intent.travelers.adults + intent.travelers.children;
        if (!stay) release('The plan has no hotel to keep.');
        else if (stay.checkIn !== intent.departureDate || stay.checkOut !== intent.returnDate) {
          release('The hotel cannot be kept: it was for the old dates.');
        } else if (stay.rooms > Math.max(1, travellers)) {
          release('The hotel cannot be kept: it has more rooms than your group needs.');
        } else keep.push(component);
        break;
      }
      case 'activities':
        if (plan.activities.length === 0) release('The plan has no activities to keep.');
        else keep.push(component);
        break;
    }
  }
  return { keep, released };
}
