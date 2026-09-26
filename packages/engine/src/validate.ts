import {
  findHard,
  formatMoney,
  hasWaiver,
  isGreater,
  subtract,
  seatedTravelers,
  type AccessibilityNeed,
  type ConstraintSet,
  type CostBreakdown,
  type ItineraryItem,
  type JourneyClassification,
  type SelectedHotel,
  type TransportOffer,
  type TravelerProfile,
  type TripIntent,
  type ValidationIssue,
} from '@trip/shared';
import { describeNeeds, unconfirmedHotelNeeds } from './accessibility.js';
import { localParts, minutesBetween } from './time.js';
import { timeWindowViolations } from './time-windows.js';

/**
 * Deterministic validation.
 *
 * This runs after the AI layer has had its say and has the final word. The
 * model can propose, rank and explain; it cannot certify that an itinerary is
 * physically possible. Everything below is arithmetic over instants and
 * constraints, which means it cannot be talked out of a blocker.
 *
 * Severity has a precise meaning:
 *   blocker  - the plan cannot be executed as written.
 *   warning  - executable, but a person would want to know.
 *   info     - an assumption worth stating.
 */

export interface ValidationInput {
  intent: TripIntent;
  classification: JourneyClassification;
  profile: TravelerProfile;
  constraints: ConstraintSet;
  items: ItineraryItem[];
  cost: CostBreakdown;
  outbound: TransportOffer | null;
  inbound: TransportOffer | null;
  hotel: SelectedHotel | null;
}

/** Needs that no connected activity source publishes anything about. */
const UNCHECKABLE_FOR_ACTIVITIES: ReadonlySet<AccessibilityNeed> = new Set<AccessibilityNeed>([
  'service_animal',
  'visual_assistance',
  'hearing_assistance',
]);

/** Shortest gap that counts as making a connection at all. */
const MIN_CONNECTION_MINUTES = 20;
/** A day this long is a warning: it is executable and still exhausting. */
const MAX_ACTIVE_MINUTES_PER_DAY = 14 * 60;

export function validateItinerary(input: ValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const items = [...input.items].sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));

  // A `rest` item is a stretch of free time ("Unplanned day"), which may
  // legitimately contain meals and anything else; it is not a commitment to be
  // somewhere, so it cannot overlap them. Ordering is checked among the rest.
  issues.push(...checkSequencing(items.filter((i) => i.kind !== 'rest')));
  issues.push(...checkDates(input));
  issues.push(...checkBudget(input));
  issues.push(...checkCompleteness(input));
  issues.push(...checkHardConstraints(input));
  issues.push(...checkTravelerNeeds(input));
  issues.push(...checkDayLoad(items));
  issues.push(...checkDataGaps(items));

  return issues;
}

/** Nothing may start before the thing before it ends. */
function checkSequencing(items: ItineraryItem[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (let i = 1; i < items.length; i += 1) {
    const prev = items[i - 1]!;
    const current = items[i]!;
    const gap = minutesBetween(prev.endUtc, current.startUtc);

    if (gap < 0) {
      issues.push({
        code: 'overlapping_items',
        severity: 'blocker',
        message: `"${current.title}" starts ${Math.abs(gap)} minutes before "${prev.title}" finishes.`,
        itemIds: [prev.id, current.id],
        suggestions: [
          'Move one of the two, or drop the earlier one.',
          'Choose a later departure for the leg that follows.',
        ],
      });
      continue;
    }

    // A transfer that lands you at the gate with nine minutes to spare is not
    // a plan, it is a gamble. Terminal legs get a stricter floor.
    const isTerminalHandoff =
      (prev.kind === 'transfer' && current.kind === 'buffer') ||
      (prev.kind === 'buffer' && current.kind === 'transport');
    if (isTerminalHandoff && gap < MIN_CONNECTION_MINUTES && gap >= 0) {
      issues.push({
        code: 'tight_connection',
        severity: 'warning',
        message: `Only ${gap} minutes between "${prev.title}" and "${current.title}".`,
        itemIds: [prev.id, current.id],
        suggestions: ['Leave earlier, or pick a later departure.'],
      });
    }
  }
  return issues;
}

function checkDates(input: ValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { departureDate, returnDate } = input.intent;

  const today = new Date().toISOString().slice(0, 10);
  if (departureDate < today) {
    issues.push({
      code: 'departure_in_past',
      severity: 'blocker',
      message: `The departure date ${departureDate} has already passed.`,
      itemIds: [],
      suggestions: ['Pick a departure date from today onwards.'],
    });
  }
  if (returnDate && returnDate < departureDate) {
    issues.push({
      code: 'return_before_departure',
      severity: 'blocker',
      message: `The return date ${returnDate} is before the departure date ${departureDate}.`,
      itemIds: [],
      suggestions: ['Swap the two dates, or correct the return date.'],
    });
  }

  if (input.outbound && input.hotel) {
    const arrival = input.items.find((i) => i.kind === 'transport')?.endUtc;
    if (arrival) {
      const arrivalDate = localParts(arrival, input.intent.destination.timezone).date;
      if (arrivalDate > input.hotel.checkIn) {
        issues.push({
          code: 'arrival_after_checkin',
          severity: 'warning',
          message: `You arrive on ${arrivalDate} but the room is booked from ${input.hotel.checkIn}, so the first night would be paid for and unused.`,
          itemIds: [],
          suggestions: [
            'Move the room booking to start on the arrival date.',
            'Choose an earlier departure.',
          ],
        });
      }
    }
  }
  return issues;
}

/**
 * An unknown cost is not zero, so a total that leaves costs out has to say
 * so. With a budget set, "within budget" cannot be confirmed until they are
 * known, which makes it a warning rather than a footnote.
 */
function checkCompleteness(input: ValidationInput): ValidationIssue[] {
  const missing = input.cost.notIncluded;
  if (missing.length === 0) return [];
  const labels = missing.map((m) => m.label.toLowerCase()).join(', ');
  const budget = input.constraints.budget.total;
  return [
    {
      code: 'total_incomplete',
      severity: budget ? 'warning' : 'info',
      message: budget
        ? `The total of ${formatMoney(input.cost.total)} does not include ${labels}, so it may still rise above what is shown against your budget.`
        : `The total of ${formatMoney(input.cost.total)} does not include ${labels}.`,
      itemIds: [],
      suggestions: [],
    },
  ];
}

function checkBudget(input: ValidationInput): ValidationIssue[] {
  const budget = input.constraints.budget.total;
  if (!budget || budget.currency !== input.cost.total.currency) return [];
  if (!isGreater(input.cost.total, budget)) return [];
  const over = formatMoney(subtract(input.cost.total, budget));
  if (!input.constraints.budget.firm) {
    // A guide, not a limit: the plan is still worth showing, and the ranking
    // has already counted the overrun against it.
    return [
      {
        code: 'over_budget_guide',
        severity: 'warning',
        message: `This plan costs ${formatMoney(input.cost.total)}, which is ${over} above your budget of ${formatMoney(budget)}. You said the budget is a guide, so it is shown, but ranked lower.`,
        itemIds: [],
        suggestions: ['Look at the suggested adjustments, or say the budget is a firm limit and the planner will stay within it.'],
      },
    ];
  }
  if (hasWaiver(input.constraints, 'max_total_budget')) {
    return [
      {
        code: 'budget_exceeded_waived',
        severity: 'info',
        message: `The plan costs ${formatMoney(input.cost.total)}, above the ${formatMoney(budget)} budget you agreed to exceed.`,
        itemIds: [],
        suggestions: [],
      },
    ];
  }
  return [
    {
      code: 'budget_exceeded',
      severity: 'blocker',
      message: `The plan costs ${formatMoney(input.cost.total)} against a budget of ${formatMoney(budget)}.`,
      itemIds: [],
      suggestions: [
        'Look at the suggested adjustments, or raise the budget.',
        'Nothing is changed automatically to fit the number.',
      ],
    },
  ];
}

function checkHardConstraints(input: ValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { constraints, outbound, inbound, hotel, intent } = input;

  // Time windows, with the same definition the transport filter uses, read in
  // local time where each departure and arrival happens.
  const legs: Array<[TransportOffer | null, string, string, string]> = [
    [outbound, intent.origin.timezone, intent.destination.timezone, 'outbound'],
    [inbound, intent.destination.timezone, intent.origin.timezone, 'return'],
  ];
  for (const [offer, departure, arrival, leg] of legs) {
    if (!offer) continue;
    for (const v of timeWindowViolations(offer, constraints, { departure, arrival })) {
      issues.push({
        code: v.kind === 'earliest_departure_time' ? 'departs_too_early' : 'arrives_too_late',
        severity: 'blocker',
        message: `The ${leg} journey does not fit your time window. ${v.reason}`,
        itemIds: [],
        suggestions: ['Choose a different departure, or change the time window.'],
      });
    }
  }

  const maxStops = findHard(constraints, 'max_stops')?.value;
  for (const offer of [outbound, inbound]) {
    if (offer && maxStops !== undefined && offer.transfers > maxStops) {
      issues.push({
        code: 'too_many_transfers',
        severity: 'blocker',
        message: `A leg has ${offer.transfers} change(s) and you asked for no more than ${maxStops}.`,
        itemIds: [],
        suggestions: ['Allow one more change, or accept a different departure time.'],
      });
    }
  }

  const requiredRooms = findHard(constraints, 'required_rooms')?.value;
  if (hotel && requiredRooms !== undefined && hotel.rooms < requiredRooms) {
    issues.push({
      code: 'insufficient_rooms',
      severity: 'blocker',
      message: `The plan books ${hotel.rooms} room(s); you require ${requiredRooms}.`,
      itemIds: [],
      suggestions: ['Pick a property with more rooms available on these dates.'],
    });
  }

  if (hotel) {
    const guests = seatedTravelers(intent.travelers);
    const capacity = hotel.room.maxOccupancy;
    if (capacity !== null && capacity * hotel.rooms < guests) {
      issues.push({
        code: 'occupancy_exceeded',
        severity: 'blocker',
        message: `${guests} guests do not fit in ${hotel.rooms} room(s) that sleep ${capacity} each.`,
        itemIds: [],
        suggestions: ['Add a room, or choose a property with larger rooms.'],
      });
    }
  }

  if (
    Boolean(findHard(constraints, 'required_free_cancellation')) &&
    hotel &&
    hotel.room.refundable !== true
  ) {
    issues.push({
      code: 'cancellation_requirement_unmet',
      severity: 'blocker',
      message:
        'You required free cancellation, and the selected rate is not confirmed as refundable by the provider.',
      itemIds: [],
      suggestions: ['Choose a flexible rate, or drop the free-cancellation requirement.'],
    });
  }

  const excluded = constraints.hard
    .filter((c) => c.kind === 'excluded_transport_mode')
    .map((c) => String(c.value));
  for (const offer of [outbound, inbound]) {
    if (offer && excluded.includes(offer.mode)) {
      issues.push({
        code: 'excluded_mode_used',
        severity: 'blocker',
        message: `The plan uses ${offer.mode.replace('_', ' ')}, which you ruled out.`,
        itemIds: [],
        suggestions: ['Allow this mode again, or search the remaining modes.'],
      });
    }
  }
  return issues;
}

function checkTravelerNeeds(input: ValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const needs = findHard(input.constraints, 'required_accessibility')?.value ?? [];
  if (needs.length > 0) {
    // A hard requirement: the hotel filter should already have removed any
    // property that does not confirm it, and this is the final check that
    // nothing reached a plan without that confirmation.
    const unconfirmed = input.hotel ? unconfirmedHotelNeeds(input.hotel.hotel, needs) : [];
    if (input.hotel && unconfirmed.length > 0) {
      issues.push({
        code: 'accessibility_requirement_unmet',
        severity: 'blocker',
        message: `${input.hotel.hotel.name} does not publish that it offers ${describeNeeds(unconfirmed)}, which you said is required. This is missing information, not a statement that the property is inaccessible.`,
        itemIds: [],
        suggestions: [
          'Choose a property that publishes this information.',
          'Contact the property directly to confirm before relying on it.',
        ],
      });
    }

    // No connected rail, bus or road source publishes accessibility, so the
    // planner cannot confirm it for those legs and says so rather than
    // staying silent.
    const surface = [input.outbound, input.inbound].filter(
      (o): o is TransportOffer => o !== null && o.mode !== 'flight',
    );
    if (surface.length > 0) {
      const modes = [...new Set(surface.map((o) => o.mode.replace('_', ' ')))].join(' and ');
      issues.push({
        code: 'transport_accessibility_unconfirmed',
        severity: 'warning',
        message: `The ${modes} in this plan cannot be confirmed to meet your accessibility needs: the connected sources do not publish that information.`,
        itemIds: [],
        suggestions: ['Confirm with the operator before travelling.'],
      });
    }

    // Activity sources publish wheelchair details only. Other needs cannot
    // be checked against them, and the traveller should know which.
    const uncheckable = needs.filter((n) => UNCHECKABLE_FOR_ACTIVITIES.has(n));
    if (uncheckable.length > 0 && input.items.some((i) => i.kind === 'activity')) {
      issues.push({
        code: 'activity_accessibility_unconfirmed',
        severity: 'warning',
        message: `The places to visit in this plan could not be checked for ${describeNeeds(uncheckable)}: the connected sources do not publish it.`,
        itemIds: input.items.filter((i) => i.kind === 'activity').map((i) => i.id),
        suggestions: ['Confirm with each venue before visiting.'],
      });
    }

    if (input.outbound?.mode === 'flight' || input.inbound?.mode === 'flight') {
      issues.push({
        code: 'assistance_must_be_requested',
        severity: 'info',
        message:
          'Airport assistance has to be requested from the airline, usually at least 48 hours before departure. It is not included in a fare by default.',
        itemIds: [],
        suggestions: [],
      });
    }
  }

  // A late arrival with nobody expecting you is the classic planning failure.
  const lastTransport = [...input.items].reverse().find((i) => i.kind === 'transport');
  if (lastTransport) {
    const arrival = localParts(lastTransport.endUtc, input.intent.destination.timezone);
    if (arrival.hour >= 23 || arrival.hour < 5) {
      issues.push({
        code: 'late_night_arrival',
        severity: 'warning',
        message: `You arrive at ${arrival.time} local time. Late arrivals mean fewer transfer options and a reception desk that may be unstaffed.`,
        itemIds: [lastTransport.id],
        suggestions: [
          'Arrange the transfer in advance.',
          'Tell the property you are arriving late so the room is held.',
          'Ask for an earlier departure.',
        ],
      });
    }
  }
  return issues;
}

function checkDayLoad(items: ItineraryItem[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byDate = new Map<string, ItineraryItem[]>();
  for (const item of items) {
    const date = localParts(item.startUtc, item.timezone).date;
    byDate.set(date, [...(byDate.get(date) ?? []), item]);
  }
  for (const [date, dayItems] of byDate) {
    const first = dayItems[0]!;
    const last = dayItems[dayItems.length - 1]!;
    const span = minutesBetween(first.startUtc, last.endUtc);
    if (span > MAX_ACTIVE_MINUTES_PER_DAY) {
      issues.push({
        code: 'overloaded_day',
        severity: 'warning',
        message: `${date} runs about ${Math.round(span / 60)} hours from first to last item.`,
        itemIds: dayItems.map((i) => i.id),
        suggestions: ['Move something to another day, or drop the last stop.'],
      });
    }
  }
  return issues;
}

/** States, rather than hides, the places where a provider told us nothing. */
function checkDataGaps(items: ItineraryItem[]): ValidationIssue[] {
  const unknownHours = items.filter((i) =>
    i.notes.some((n) => n.includes('Opening hours are not published')),
  );
  if (unknownHours.length === 0) return [];
  return [
    {
      code: 'opening_hours_unknown',
      severity: 'warning',
      message: `${unknownHours.length} place(s) in this plan publish no opening hours, so their slots are unverified.`,
      itemIds: unknownHours.map((i) => i.id),
      suggestions: ['Check those venues directly before the day.'],
    },
  ];
}
