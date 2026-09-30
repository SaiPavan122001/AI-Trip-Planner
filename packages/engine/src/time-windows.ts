import {
  findHard,
  hasWaiver,
  type ConstraintSet,
  type TransportOffer,
} from '@trip/shared';
import { instantFrom, localParts } from './time.js';

/**
 * The traveller's time windows: "leave no earlier than 09:00" and "arrive no
 * later than 22:00". Both are hard constraints, applied to every leg, outbound
 * and return, and both are read in local time where they happen: a departure
 * in the zone it departs from, an arrival in the zone it arrives in.
 *
 * "Arrive by 22:00" means by 22:00 on the local date the leg sets off. A leg
 * that runs overnight and arrives at 06:00 the next day has not arrived by
 * 22:00, so it does not meet the requirement.
 *
 * This is the single definition. The transport filter uses it to drop
 * options before ranking, and the validator uses it as the final check on
 * every plan, so the two can never disagree.
 */

export interface LegZones {
  /** Zone of the place the leg departs from, used when a segment has none. */
  departure: string;
  /** Zone of the place the leg arrives at, used when a segment has none. */
  arrival: string;
}

export interface TimeWindowViolation {
  kind: 'earliest_departure_time' | 'latest_arrival_time';
  reason: string;
}

/**
 * The local time a leg arrives, when that is in the small hours (23:00 to
 * 05:00), and null when it is not. Used for "do not arrive late at night":
 * a late arrival means fewer ways to reach the hotel and a desk that may be
 * closed. Read in the zone where the leg arrives, like every other window.
 */
export function smallHoursArrival(offer: TransportOffer, zones: LegZones): string | null {
  const last = offer.segments[offer.segments.length - 1];
  if (!last) return null;
  const zone = last.destination.timezone ?? zones.arrival;
  const arrives = localParts(instantFrom(last.arrivalAt, zone), zone);
  return arrives.hour >= 23 || arrives.hour < 5 ? arrives.time : null;
}

export function timeWindowViolations(
  offer: TransportOffer,
  constraints: ConstraintSet,
  zones: LegZones,
): TimeWindowViolation[] {
  const earliest = hasWaiver(constraints, 'earliest_departure_time')
    ? undefined
    : findHard(constraints, 'earliest_departure_time')?.value;
  const latest = hasWaiver(constraints, 'latest_arrival_time')
    ? undefined
    : findHard(constraints, 'latest_arrival_time')?.value;
  if (!earliest && !latest) return [];

  const first = offer.segments[0];
  const last = offer.segments[offer.segments.length - 1];
  if (!first || !last) return [];

  const departureZone = first.origin.timezone ?? zones.departure;
  const arrivalZone = last.destination.timezone ?? zones.arrival;
  const departs = localParts(instantFrom(first.departureAt, departureZone), departureZone);
  const arrives = localParts(instantFrom(last.arrivalAt, arrivalZone), arrivalZone);

  const out: TimeWindowViolation[] = [];
  if (earliest && departs.time < earliest) {
    out.push({
      kind: 'earliest_departure_time',
      reason: `Leaves at ${departs.time} local time; you asked to leave no earlier than ${earliest}.`,
    });
  }
  if (latest) {
    if (arrives.date > departs.date) {
      out.push({
        kind: 'latest_arrival_time',
        reason: `Arrives on ${arrives.date} at ${arrives.time} local time, after the day it leaves; you asked to arrive by ${latest}.`,
      });
    } else if (arrives.time > latest) {
      out.push({
        kind: 'latest_arrival_time',
        reason: `Arrives at ${arrives.time} local time; you asked to arrive by ${latest}.`,
      });
    }
  }
  return out;
}
