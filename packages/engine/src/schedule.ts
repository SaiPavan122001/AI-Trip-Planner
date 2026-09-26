import { passthroughPolicy, type ProviderRegistry } from '@trip/providers';
import {
  add,
  divide,
  haversineKm,
  isOk,
  multiply,
  noteFromFailure,
  noteFromWarning,
  seatedTravelers,
  zero,
  type ActivityOffer,
  type Coordinates,
  type ItineraryDay,
  type ItineraryItem,
  type JourneyClassification,
  type Money,
  type Place,
  type ProviderNote,
  type SelectedHotel,
  type TransferOffer,
  type TransportOffer,
  type TravelerProfile,
  type TripIntent,
} from '@trip/shared';
import { assumedDuration, earliestOpenStart } from './activities.js';
import { supportedPriceOrUnknown } from './currency.js';
import { addMinutes, instantFrom, localParts, minutesBetween, utcFromLocal } from './time.js';

/**
 * Itinerary construction.
 *
 * This is where a pile of offers becomes something a person can actually do.
 * The scheduler works forward in absolute time, so every constraint it applies
 * is a real one: you cannot be at the airport before the taxi arrives, you
 * cannot check in before the hotel opens its desk, and you cannot visit a
 * museum on the day it is shut.
 *
 * Where it has to assume something — how long a visit takes, how long the
 * airport queue is — the assumption is attached to the item as a note instead
 * of disappearing into the arithmetic.
 */

/** Minutes to be at the terminal before departure, by mode and journey scope. */
const TERMINAL_BUFFER: Record<string, { domestic: number; international: number }> = {
  flight: { domestic: 120, international: 180 },
  train: { domestic: 30, international: 45 },
  bus: { domestic: 20, international: 30 },
  self_drive: { domestic: 0, international: 0 },
};

/** Assumed transfer time when no routing provider can measure the leg. */
const ASSUMED_TRANSFER_MINUTES = 45;

/**
 * Whether a mode departs from a terminal you have to reach and check in at.
 * Driving your own car does not: the journey starts at your door and ends at
 * the hotel's, so inserting transfers around it would invent legs that do not
 * exist.
 */
function usesTerminal(mode: TransportOffer['mode']): boolean {
  return mode !== 'self_drive' && mode !== 'rental_car' && mode !== 'taxi';
}

const DEFAULT_CHECK_IN = '14:00';
const DEFAULT_CHECK_OUT = '11:00';
const DAY_START = '09:30';
const LUNCH_AT = '13:00';
const LUNCH_MINUTES = 60;
const DINNER_AT = '19:30';
const DINNER_MINUTES = 90;
const DAY_END = '21:30';
/** How long the check-out desk takes, and the least time left between it and setting off. */
const CHECK_OUT_MINUTES = 20;

export interface ScheduleInput {
  registry: ProviderRegistry;
  intent: TripIntent;
  classification: JourneyClassification;
  profile: TravelerProfile;
  outbound: TransportOffer | null;
  inbound: TransportOffer | null;
  hotel: SelectedHotel | null;
  /** One cluster of activities per full day at the destination. */
  clusters: ActivityOffer[][];
  /** Per-person, per-day allowance for meals, used to cost meal items. */
  dailyMealBudget: Money | null;
}

export interface ScheduleResult {
  days: ItineraryDay[];
  items: ItineraryItem[];
  transfers: TransferOffer[];
  scheduledActivities: ActivityOffer[];
  /** Activities that could not be placed, each with the reason. */
  unscheduled: Array<{ activity: ActivityOffer; reason: string }>;
  notes: ProviderNote[];
}

let itemCounter = 0;
function itemId(prefix: string): string {
  itemCounter += 1;
  return `${prefix}-${itemCounter.toString(36)}`;
}

export async function buildItinerary(input: ScheduleInput): Promise<ScheduleResult> {
  const { intent, classification, outbound, inbound, hotel } = input;
  const items: ItineraryItem[] = [];
  const transfers: TransferOffer[] = [];
  const notes: ProviderNote[] = [];
  const unscheduled: Array<{ activity: ActivityOffer; reason: string }> = [];
  const scheduledActivities: ActivityOffer[] = [];

  const originTz = intent.origin.timezone;
  const destinationTz = intent.destination.timezone;

  // ------------------------------------------------------ outbound journey
  let arrivalAtDestination: string | null = null;
  if (outbound) {
    const firstSegment = outbound.segments[0]!;
    const lastSegment = outbound.segments[outbound.segments.length - 1]!;
    const departUtc = instantFrom(firstSegment.departureAt, firstSegment.origin.timezone ?? originTz);
    const arriveUtc = instantFrom(
      lastSegment.arrivalAt,
      lastSegment.destination.timezone ?? destinationTz,
    );
    arrivalAtDestination = arriveUtc;

    const buffer =
      TERMINAL_BUFFER[outbound.mode]?.[classification.scope] ??
      (outbound.mode === 'self_drive' ? 0 : 45);

    // Driving your own car has no terminal: you leave from where you are, so
    // a transfer to a departure point and a check-in allowance would both be
    // fictions — and zero-length ones at that, which the validator would then
    // flag as impossibly tight connections.
    if (usesTerminal(outbound.mode)) {
      const departurePoint = terminalPoint(
        intent.origin,
        firstSegment.origin.code,
        firstSegment.origin.name,
      );
      const toTerminal = await transferItem(
        input,
        { name: intent.origin.name, coordinates: intent.origin.coordinates },
        departurePoint,
        addMinutes(departUtc, -(buffer + ASSUMED_TRANSFER_MINUTES)),
        originTz,
        `Travel to ${departurePoint.name}`,
        notes,
      );
      if (toTerminal.offer) transfers.push(toTerminal.offer);

      // Work backwards from the departure so the traveller arrives in time,
      // rather than forwards from an arbitrary "leave at 6am".
      const transferMinutes = toTerminal.durationMinutes;
      const leaveHomeUtc = addMinutes(departUtc, -(buffer + transferMinutes));
      items.push({
        ...toTerminal.item,
        startUtc: leaveHomeUtc,
        endUtc: addMinutes(leaveHomeUtc, transferMinutes),
      });
      items.push({
        id: itemId('buffer'),
        kind: 'buffer',
        title: `Check in at ${departurePoint.name}`,
        description: `${buffer} minutes before departure${
          outbound.mode === 'flight'
            ? classification.scope === 'international'
              ? ', which is the usual guidance for an international flight'
              : ', which is the usual guidance for a domestic flight'
            : ''
        }.`,
        startUtc: addMinutes(departUtc, -buffer),
        endUtc: departUtc,
        timezone: firstSegment.origin.timezone ?? originTz,
        locationName: departurePoint.name,
        cost: null,
        costIsEstimate: false,
        offerRef: null,
        notes: ['Terminal time is an allowance, not a measured queue.'],
      });
    }

    items.push(transportItem(outbound, departUtc, arriveUtc, originTz, destinationTz));
  }

  // ------------------------------------------------------- arrival + hotel
  if (hotel && arrivalAtDestination) {
    const hotelPoint = { name: hotel.hotel.name, coordinates: hotel.hotel.coordinates };
    const arrivalPoint = outbound
      ? terminalPoint(
          intent.destination,
          outbound.segments[outbound.segments.length - 1]!.destination.code,
          outbound.segments[outbound.segments.length - 1]!.destination.name,
        )
      : { name: intent.destination.name, coordinates: intent.destination.coordinates };

    // Arriving under your own steam means you park at the hotel: there is no
    // onward transfer to schedule or to charge for.
    const needsOnwardTransfer = !outbound || usesTerminal(outbound.mode);
    let reachedHotel = arrivalAtDestination;

    if (needsOnwardTransfer) {
      const toHotel = await transferItem(
        input,
        arrivalPoint,
        hotelPoint,
        arrivalAtDestination,
        destinationTz,
        `Transfer to ${hotel.hotel.name}`,
        notes,
      );
      if (toHotel.offer) transfers.push(toHotel.offer);

      // Time to clear the terminal before the transfer can start. It is longer
      // in practice with checked bags, and the note says so.
      const clearTerminal = outbound?.mode === 'flight' ? 40 : 10;
      const transferStart = addMinutes(arrivalAtDestination, clearTerminal);
      items.push({
        ...toHotel.item,
        startUtc: transferStart,
        endUtc: addMinutes(transferStart, toHotel.durationMinutes),
      });
      reachedHotel = addMinutes(transferStart, toHotel.durationMinutes);
    }

    const checkInLocal = hotel.hotel.checkInTime ?? DEFAULT_CHECK_IN;
    const arrivalDate = localParts(reachedHotel, destinationTz).date;
    const checkInEarliest = utcFromLocal(arrivalDate, checkInLocal, destinationTz);
    const checkInStart =
      Date.parse(reachedHotel) > Date.parse(checkInEarliest) ? reachedHotel : checkInEarliest;

    const earlyBy = minutesBetween(reachedHotel, checkInStart);
    items.push({
      id: itemId('checkin'),
      kind: 'check_in',
      title: `Check in at ${hotel.hotel.name}`,
      description: `${hotel.rooms} room(s), ${hotel.nights} night(s).`,
      startUtc: checkInStart,
      endUtc: addMinutes(checkInStart, 20),
      timezone: destinationTz,
      locationName: hotel.hotel.name,
      cost: hotel.room.totalPrice,
      costIsEstimate: false,
      offerRef: { kind: 'hotel', offerId: hotel.hotel.id },
      notes:
        earlyBy > 30
          ? [
              `You arrive about ${Math.round(earlyBy / 60)}h before check-in opens at ${checkInLocal}. Most properties will hold luggage, but early check-in is not guaranteed and has not been requested.`,
            ]
          : [],
    });
  }

  // ---------------------------------------------------------- full days
  if (hotel && arrivalAtDestination) {
    const firstFullDate = nextLocalDate(localParts(arrivalAtDestination, destinationTz).date);
    const checkoutDate = hotel.checkOut;
    const dayDates: string[] = [];
    let cursor = firstFullDate;
    while (cursor < checkoutDate) {
      dayDates.push(cursor);
      cursor = nextLocalDate(cursor);
    }

    for (let i = 0; i < dayDates.length; i += 1) {
      const date = dayDates[i]!;
      const cluster = input.clusters[i] ?? [];
      const dayItems = await scheduleDay(
        input,
        date,
        cluster,
        hotel,
        destinationTz,
        unscheduled,
        scheduledActivities,
        transfers,
        notes,
      );
      items.push(...dayItems);
    }
  }

  /** When the traveller has to leave the hotel for the journey home. */
  let leaveHotelUtc: string | null = null;

  if (inbound) {
    const firstSegment = inbound.segments[0]!;
    const lastSegment = inbound.segments[inbound.segments.length - 1]!;
    const departUtc = instantFrom(
      firstSegment.departureAt,
      firstSegment.origin.timezone ?? destinationTz,
    );
    const arriveUtc = instantFrom(lastSegment.arrivalAt, lastSegment.destination.timezone ?? originTz);
    const buffer =
      TERMINAL_BUFFER[inbound.mode]?.[classification.scope] ??
      (inbound.mode === 'self_drive' ? 0 : 45);

    const departurePoint = terminalPoint(
      intent.destination,
      firstSegment.origin.code,
      firstSegment.origin.name,
    );
    const from = hotel
      ? { name: hotel.hotel.name, coordinates: hotel.hotel.coordinates }
      : { name: intent.destination.name, coordinates: intent.destination.coordinates };

    // As on the way out: a self-drive return starts at the hotel door, so it
    // gets no transfer to a terminal and no check-in allowance.
    if (usesTerminal(inbound.mode)) {
      const toTerminal = await transferItem(
        input,
        from,
        departurePoint,
        addMinutes(departUtc, -(buffer + ASSUMED_TRANSFER_MINUTES)),
        destinationTz,
        `Travel to ${departurePoint.name}`,
        notes,
      );
      if (toTerminal.offer) transfers.push(toTerminal.offer);

      const leaveUtc = addMinutes(departUtc, -(buffer + toTerminal.durationMinutes));
      leaveHotelUtc = leaveUtc;
      items.push({
        ...toTerminal.item,
        startUtc: leaveUtc,
        endUtc: addMinutes(leaveUtc, toTerminal.durationMinutes),
      });
      items.push({
        id: itemId('buffer'),
        kind: 'buffer',
        title: `Check in at ${departurePoint.name}`,
        description: `${buffer} minutes before departure.`,
        startUtc: addMinutes(departUtc, -buffer),
        endUtc: departUtc,
        timezone: firstSegment.origin.timezone ?? destinationTz,
        locationName: departurePoint.name,
        cost: null,
        costIsEstimate: false,
        offerRef: null,
        notes: [],
      });
    }
    // Your own car leaves from the hotel door.
    leaveHotelUtc ??= departUtc;
    items.push(transportItem(inbound, departUtc, arriveUtc, destinationTz, originTz));
  }

  // ------------------------------------------------------ check-out
  // The property's usual time, unless the journey home leaves before it: you
  // cannot check out after you have left.
  if (hotel && arrivalAtDestination) {
    const checkOutLocal = hotel.hotel.checkOutTime ?? DEFAULT_CHECK_OUT;
    const usual = utcFromLocal(hotel.checkOut, checkOutLocal, destinationTz);
    const latest = leaveHotelUtc === null ? null : addMinutes(leaveHotelUtc, -CHECK_OUT_MINUTES);
    const checkoutUtc = latest !== null && Date.parse(latest) < Date.parse(usual) ? latest : usual;
    const early = checkoutUtc !== usual;
    items.push({
      id: itemId('checkout'),
      kind: 'check_out',
      title: `Check out of ${hotel.hotel.name}`,
      description: null,
      startUtc: checkoutUtc,
      endUtc: addMinutes(checkoutUtc, CHECK_OUT_MINUTES),
      timezone: destinationTz,
      locationName: hotel.hotel.name,
      cost: null,
      costIsEstimate: false,
      offerRef: null,
      notes: early
        ? [`Your journey home leaves before the usual ${checkOutLocal} check-out, so check out before you go.`]
        : [],
    });
  }

  items.sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
  // Numbered in time order once everything is placed, so the same trip always
  // gets the same ids (they were a process-wide counter, which differed from
  // one search to the next and depended on what else had been planned).
  items.forEach((item, i) => {
    item.id = `${item.kind}-${i + 1}`;
  });
  return {
    days: groupIntoDays(items, intent.currency),
    items,
    transfers,
    scheduledActivities,
    unscheduled,
    notes,
  };
}

// ------------------------------------------------------------------ days

/** Whether two half-open time ranges share any time. */
function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return Date.parse(aStart) < Date.parse(bEnd) && Date.parse(bStart) < Date.parse(aEnd);
}

/**
 * Visits in the order that keeps the day short: from the hotel, always the
 * nearest place not yet visited. Not a tour-optimiser, and it does not claim
 * to be; it removes the zig-zag, which is what costs a day its hours.
 */
export function orderByNearest(from: Coordinates, places: ActivityOffer[]): ActivityOffer[] {
  const remaining = [...places];
  const ordered: ActivityOffer[] = [];
  let here = from;
  while (remaining.length > 0) {
    let best = 0;
    for (let i = 1; i < remaining.length; i += 1) {
      if (haversineKm(here, remaining[i]!.coordinates) < haversineKm(here, remaining[best]!.coordinates)) best = i;
    }
    const next = remaining.splice(best, 1)[0]!;
    ordered.push(next);
    here = next.coordinates;
  }
  return ordered;
}

async function scheduleDay(
  input: ScheduleInput,
  date: string,
  cluster: ActivityOffer[],
  hotel: SelectedHotel,
  timezone: string,
  unscheduled: Array<{ activity: ActivityOffer; reason: string }>,
  scheduled: ActivityOffer[],
  transfers: TransferOffer[],
  notes: ProviderNote[],
): Promise<ItineraryItem[]> {
  const items: ItineraryItem[] = [];
  const dayStart = utcFromLocal(date, DAY_START, timezone);
  const dayEnd = utcFromLocal(date, DAY_END, timezone);
  // Meals are fixed points in the day. A visit, and the journey to it, is
  // planned around them instead of running through them.
  const lunch = { start: utcFromLocal(date, LUNCH_AT, timezone) };
  const lunchEnd = addMinutes(lunch.start, LUNCH_MINUTES);
  const dinner = { start: utcFromLocal(date, DINNER_AT, timezone) };
  const dinnerEnd = addMinutes(dinner.start, DINNER_MINUTES);
  const reserved = [
    { start: lunch.start, end: lunchEnd },
    { start: dinner.start, end: dinnerEnd },
  ];

  let cursor = dayStart;
  let lastPoint: Coordinates = hotel.hotel.coordinates;
  let lastName = hotel.hotel.name;
  let nearLunch = { name: hotel.hotel.name };
  let lunchKnown = false;

  const mealCost = input.dailyMealBudget
    ? divide(multiply(input.dailyMealBudget, seatedTravelers(input.intent.travelers)), 2)
    : null;

  for (const activity of orderByNearest(hotel.hotel.coordinates, cluster)) {
    const legMinutes = estimateLocalLegMinutes(lastPoint, activity.coordinates);
    const { minutes, assumed } = assumedDuration(activity);

    // Find the earliest start that works: after the journey there, inside the
    // opening hours for the whole visit, and clear of both meals. Each fix can
    // invalidate another, so it is repeated until the start stops moving.
    let start = addMinutes(cursor, legMinutes);
    let hours: 'unknown' | 'open' | 'closed' = 'unknown';
    for (let pass = 0; pass < 6; pass += 1) {
      const open = earliestOpenStart(activity, start, minutes, timezone);
      hours = open.status;
      if (open.status === 'closed') break;
      let next = open.status === 'open' ? open.startUtc : start;
      const end = addMinutes(next, minutes);
      const leaves = addMinutes(next, -legMinutes);
      const meal = reserved.find((r) => overlaps(leaves, end, r.start, r.end));
      if (meal) next = addMinutes(meal.end, legMinutes);
      if (next === start) break;
      start = next;
    }
    const end = addMinutes(start, minutes);

    if (hours === 'closed') {
      unscheduled.push({
        activity,
        reason: `${activity.name} cannot be visited on ${date} within its published hours.`,
      });
      continue;
    }
    if (Date.parse(end) > Date.parse(dayEnd) || reserved.some((r) => overlaps(addMinutes(start, -legMinutes), end, r.start, r.end))) {
      unscheduled.push({
        activity,
        reason: `There was no room left on ${date} without running past ${DAY_END} or through a meal.`,
      });
      continue;
    }

    // The journey is timed to arrive when the visit starts, so waiting for a
    // place to open is spent where you are, not on the road.
    if (legMinutes > 0) {
      const leaves = addMinutes(start, -legMinutes);
      items.push({
        id: itemId('localtransfer'),
        kind: 'transfer',
        title: `Travel to ${activity.name}`,
        description: `About ${haversineKm(lastPoint, activity.coordinates).toFixed(1)}km from ${lastName}.`,
        startUtc: leaves,
        endUtc: start,
        timezone,
        locationName: activity.name,
        cost: null,
        costIsEstimate: true,
        offerRef: null,
        notes: ['Local travel time is estimated from straight-line distance at typical city speeds.'],
      });
    }

    const activityNotes: string[] = [];
    if (assumed) {
      activityNotes.push(
        `No visit length is published for this place; ${minutes} minutes is assumed and can be adjusted.`,
      );
    }
    if (hours === 'unknown') {
      activityNotes.push(
        'Opening hours are not published for this place. Check before you go rather than relying on this slot.',
      );
    }

    items.push({
      id: itemId('activity'),
      kind: 'activity',
      title: activity.name,
      description: activity.description,
      startUtc: start,
      endUtc: end,
      timezone,
      locationName: activity.address ?? activity.name,
      cost: activity.price,
      costIsEstimate: activity.priceIsEstimate,
      offerRef: { kind: 'activity', offerId: activity.id },
      notes: activityNotes,
    });
    scheduled.push(activity);

    cursor = end;
    lastPoint = activity.coordinates;
    lastName = activity.name;
    // Lunch is eaten near wherever the morning ended.
    if (!lunchKnown && Date.parse(end) <= Date.parse(lunch.start)) nearLunch = { name: activity.name };
    if (Date.parse(end) > Date.parse(lunch.start)) lunchKnown = true;
  }

  items.push(mealItem('Lunch', lunch.start, LUNCH_MINUTES, timezone, nearLunch.name, mealCost));
  items.push(mealItem('Dinner', dinner.start, DINNER_MINUTES, timezone, lastName, mealCost));

  if (cluster.length === 0) {
    items.push({
      id: itemId('rest'),
      kind: 'rest',
      title: 'Unplanned day',
      description:
        'Nothing is scheduled for this day. Either no activity source is connected, or the days outnumber the places found.',
      startUtc: utcFromLocal(date, DAY_START, timezone),
      endUtc: utcFromLocal(date, '17:00', timezone),
      timezone,
      locationName: hotel.hotel.name,
      cost: null,
      costIsEstimate: false,
      offerRef: null,
      notes: [],
    });
  }

  void transfers;
  void notes;
  return items;
}

function mealItem(
  title: string,
  startUtc: string,
  minutes: number,
  timezone: string,
  near: string,
  cost: Money | null,
): ItineraryItem {
  return {
    id: itemId('meal'),
    kind: 'meal',
    title,
    description: `Near ${near}.`,
    startUtc,
    endUtc: addMinutes(startUtc, minutes),
    timezone,
    locationName: near,
    cost,
    costIsEstimate: true,
    offerRef: null,
    notes: cost ? ['Costed from your stated daily spending allowance, not from a restaurant quote.'] : [],
  };
}

// -------------------------------------------------------------- transfers

interface TransferItemResult {
  item: ItineraryItem;
  offer: TransferOffer | null;
  durationMinutes: number;
}

async function transferItem(
  input: ScheduleInput,
  from: { name: string; coordinates: Coordinates },
  to: { name: string; coordinates: Coordinates },
  at: string,
  timezone: string,
  title: string,
  notes: ProviderNote[],
): Promise<TransferItemResult> {
  const provider = input.registry.groundTransport[0];
  const policy = input.registry.policy ?? passthroughPolicy;
  const baseItem: ItineraryItem = {
    id: itemId('transfer'),
    kind: 'transfer',
    title,
    description: null,
    startUtc: at,
    endUtc: addMinutes(at, ASSUMED_TRANSFER_MINUTES),
    timezone,
    locationName: to.name,
    cost: null,
    costIsEstimate: true,
    offerRef: null,
    notes: [],
  };

  if (!provider) {
    const missing = noteFromFailure(input.registry.missingCapabilityNote('transfers', ['osrm', 'google-maps']), 'transfers');
    if (!notes.some((n) => n.provider === missing.provider && n.capability === missing.capability && n.status === missing.status)) {
      notes.push(missing);
    }
    return {
      item: {
        ...baseItem,
        notes: [
          `No routing provider is connected, so ${ASSUMED_TRANSFER_MINUTES} minutes is assumed for this transfer and no cost is included.`,
        ],
      },
      offer: null,
      durationMinutes: ASSUMED_TRANSFER_MINUTES,
    };
  }

  const res = await policy.execute(
    {
      provider: provider.descriptor?.id ?? 'transfers',
      providerLabel: provider.descriptor?.label ?? 'Transfers',
      capability: 'transfers',
      operation: 'searchTransfers',
    },
    () =>
      provider.searchTransfers({
    from,
    to,
    at,
    timezone,
    party: input.intent.travelers,
    luggagePieces:
      input.profile.transport.checkedBagsPerTraveler * seatedTravelers(input.intent.travelers),
    accessibleRequired: input.profile.special.accessibility.length > 0,
    currency: input.intent.currency,
      }),
  );

  if (!isOk(res) || res.data.length === 0) {
    if (!isOk(res)) notes.push(noteFromFailure(res, 'transfers'));
    return {
      item: {
        ...baseItem,
        notes: [`This transfer could not be measured, so ${ASSUMED_TRANSFER_MINUTES} minutes is assumed.`],
      },
      offer: null,
      durationMinutes: ASSUMED_TRANSFER_MINUTES,
    };
  }

  // Prefer a car for terminal transfers: walking an airport run with luggage
  // is not a realistic default whatever the distance says.
  const chosen = res.data.find((o) => o.mode === 'taxi') ?? res.data[0]!;
  // The route and time are still right when the fare is in another currency;
  // only the fare becomes unknown.
  const priced = supportedPriceOrUnknown(chosen.price, chosen.provenance, 'transfers');
  if (priced.note && !notes.some((n) => n.message === priced.note!.message)) notes.push(priced.note);
  const offer: TransferOffer =
    priced.price === chosen.price
      ? chosen
      : { ...chosen, price: null, priceIsEstimate: false, estimateBasis: null };
  for (const warning of res.warnings) notes.push(noteFromWarning(res.provenance, warning, 'transfers'));

  return {
    item: {
      ...baseItem,
      description: `${offer.distanceKm}km, about ${offer.durationMinutes} minutes by ${offer.mode}.`,
      endUtc: addMinutes(at, offer.durationMinutes),
      cost: offer.price,
      costIsEstimate: offer.priceIsEstimate,
      offerRef: { kind: 'transfer', offerId: offer.id },
      notes: offer.estimateBasis ? [`Fare estimated from: ${offer.estimateBasis}`] : [],
    },
    offer,
    durationMinutes: offer.durationMinutes,
  };
}

// ---------------------------------------------------------------- helpers

function transportItem(
  offer: TransportOffer,
  departUtc: string,
  arriveUtc: string,
  fromTz: string,
  toTz: string,
): ItineraryItem {
  const first = offer.segments[0]!;
  const last = offer.segments[offer.segments.length - 1]!;
  const label = offer.segments
    .map((s) => s.serviceNumber ?? s.operatorName ?? s.mode)
    .join(' → ');

  const notes: string[] = [];
  if (offer.transfers > 0) {
    notes.push(`${offer.transfers} change(s) along the way.`);
  }
  if (fromTz !== toTz) {
    notes.push(
      `You arrive in a different timezone (${toTz}). Times shown for each leg are local to where it happens.`,
    );
  }
  if (offer.overnight) notes.push('This leg runs overnight.');

  return {
    id: itemId('transport'),
    kind: 'transport',
    title: `${first.origin.name} → ${last.destination.name}${label ? ` (${label})` : ''}`,
    description: offer.baggageSummary,
    startUtc: departUtc,
    endUtc: arriveUtc,
    timezone: first.origin.timezone ?? fromTz,
    locationName: first.origin.name,
    // The fare itself. For your own car it is an exact ₹0; its estimated
    // running costs are separate fees, counted in the cost breakdown.
    cost: offer.totalPrice,
    costIsEstimate: false,
    offerRef: { kind: 'transport', offerId: offer.id },
    notes,
  };
}

/**
 * A terminal's own coordinates when the provider gave us one, falling back to
 * the city centre. The fallback is honest about what it is: it changes a
 * transfer estimate, never a departure time.
 */
function terminalPoint(
  place: Place,
  code: string | null,
  name: string,
): { name: string; coordinates: Coordinates } {
  const airport = code ? place.airports.find((a) => a.iataCode === code) : undefined;
  if (airport?.coordinates) return { name: airport.name, coordinates: airport.coordinates };
  return { name: name || place.name, coordinates: place.coordinates };
}

/** Straight-line distance at typical urban speed, with a floor for door time. */
export function estimateLocalLegMinutes(from: Coordinates, to: Coordinates): number {
  const km = haversineKm(from, to);
  if (km < 0.4) return 0;
  const speedKmh = km < 3 ? 14 : 22;
  return Math.max(10, Math.round((km / speedKmh) * 60) + 5);
}

function nextLocalDate(date: string): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function groupIntoDays(items: ItineraryItem[], currency: string): ItineraryDay[] {
  const byDate = new Map<string, ItineraryItem[]>();
  for (const item of items) {
    const date = localParts(item.startUtc, item.timezone).date;
    const bucket = byDate.get(date) ?? [];
    bucket.push(item);
    byDate.set(date, bucket);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayItems]) => {
      const costs = dayItems
        .map((i) => i.cost)
        .filter((c): c is Money => c !== null && c.currency === currency);
      return {
        date,
        timezone: dayItems[0]?.timezone ?? 'UTC',
        items: dayItems,
        daySubtotal: costs.length ? add(...costs) : zero(currency),
      };
    });
}

/** Total of the items whose cost is modelled rather than quoted. */
export function estimatedPortion(items: ItineraryItem[], currency: string): Money {
  const estimates = items
    .filter((i) => i.costIsEstimate && i.cost && i.cost.currency === currency)
    .map((i) => i.cost!);
  return estimates.length ? add(...estimates) : zero(currency);
}

export function totalOf(items: ItineraryItem[], currency: string): Money {
  const costs = items
    .map((i) => i.cost)
    .filter((c): c is Money => c !== null && c.currency === currency);
  return costs.length ? add(...costs) : zero(currency);
}
