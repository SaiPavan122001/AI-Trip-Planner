import { toProviderFailure, type ProviderRegistry } from '@trip/providers';
import {
  compare,
  findHard,
  isOk,
  noteFromFailure,
  toMajor,
  type ProviderCapability,
  type ConstraintSet,
  type IsoDate,
  type JourneyClassification,
  type Place,
  type ProviderNote,
  type TransportMode,
  type TransportOffer,
  type TravelerProfile,
  type TripIntent,
} from '@trip/shared';
import { budgetCeiling } from './constraints.js';
import { keepSupportedTransport } from './currency.js';
import { primaryFailure, sweepProviders } from './provider-calls.js';
import { knownTransportCost } from './pricing.js';
import { smallHoursArrival, timeWindowViolations, type LegZones } from './time-windows.js';
import { scoreTransportOffers, type ScoredCandidate } from './scoring.js';

/**
 * Multi-modal transport search.
 *
 * The traveller is never asked to pick a mode first. Every mode the journey
 * classification allows is searched in parallel, the results are compared on
 * the traveller's own terms, and the comparison is handed back with its
 * trade-offs intact. Where a mode has no connected provider, that fact is
 * returned as a note rather than as an empty list, because "we could not look"
 * and "there is nothing" are different answers.
 */

export interface ModeResult {
  mode: TransportMode;
  offers: ScoredCandidate<TransportOffer>[];
  cheapest: TransportOffer | null;
  fastest: TransportOffer | null;
  /** Highest scoring against the traveller's ranked priorities. */
  bestForYou: TransportOffer | null;
  /** Why this mode has nothing, when it has nothing. */
  note: ProviderNote | null;
  /**
   * Everything the providers asked for this mode had to say, including
   * failures of a provider whose neighbour did answer: a mode with results
   * can still be missing a source, and the traveller is told.
   */
  notes: ProviderNote[];
}

export interface TransportSearchResult {
  direction: 'outbound' | 'return';
  date: IsoDate;
  modes: ModeResult[];
  notes: ProviderNote[];
  /** Offers dropped by hard constraints, with the constraint that dropped them. */
  filtered: Array<{ offerId: string; reason: string }>;
}

export interface TransportSearchDeps {
  registry: ProviderRegistry;
  intent: TripIntent;
  classification: JourneyClassification;
  profile: TravelerProfile;
  constraints: ConstraintSet;
  /** Stops every provider call in the search when it fires. */
  signal?: AbortSignal;
}

function noteFrom(
  status: string,
  provider: string,
  label: string,
  message: string,
  capability?: ProviderCapability,
): ProviderNote {
  return {
    provider,
    providerLabel: label,
    ...(capability ? { capability } : {}),
    status,
    message,
    occurredAt: new Date().toISOString(),
  };
}

/**
 * Flight search needs IATA codes, and a city name is not one. This fills in
 * the codes from the flight provider's own reference data. If it cannot, the
 * flight mode reports that it could not be searched rather than guessing an
 * airport, which is how people end up planned through the wrong Hyderabad.
 */
export async function enrichWithAirports(
  registry: ProviderRegistry,
  place: Place,
  signal?: AbortSignal,
): Promise<{ place: Place; note: ProviderNote | null }> {
  if (place.airports.length > 0 || place.iataCityCode) return { place, note: null };
  const amadeus = registry.amadeus;
  if (!amadeus) {
    return {
      place,
      note: noteFrom(
        'not_configured',
        'amadeus',
        'Amadeus',
        `No airport reference data is available for ${place.name}: set AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET to search flights.`,
        'flights',
      ),
    };
  }
  const res = await amadeus.nearestAirports(place.coordinates, undefined, signal);
  if (!isOk(res)) {
    return {
      place,
      note: noteFrom(res.status, res.provider, res.providerLabel, res.message, 'flights'),
    };
  }
  return { place: { ...place, airports: res.data }, note: null };
}

export async function searchTransport(
  deps: TransportSearchDeps,
  direction: 'outbound' | 'return',
): Promise<TransportSearchResult> {
  const { intent, classification, profile, constraints } = deps;
  const outbound = direction === 'outbound';
  const date = outbound ? intent.departureDate : intent.returnDate;
  if (!date) {
    return { direction, date: intent.departureDate, modes: [], notes: [], filtered: [] };
  }

  const from = outbound ? intent.origin : intent.destination;
  const to = outbound ? intent.destination : intent.origin;

  const excluded = new Set(
    constraints.hard
      .filter((c) => c.kind === 'excluded_transport_mode')
      .map((c) => String(c.value)),
  );
  const modes = classification.eligibleModes.filter((m) => !excluded.has(m));

  const notes: ProviderNote[] = [];
  const results: ModeResult[] = [];

  // Each mode is searched on its own and can only fail on its own: one that
  // throws becomes a note about that mode, and the others carry on.
  const searchMode = async (mode: TransportMode): Promise<ModeResult> => {
    switch (mode) {
      case 'flight':
        return searchFlightMode(deps, from, to, date);
      case 'train':
        return searchRailMode(deps, from, to, date);
      case 'bus':
        return searchBusMode(deps, from, to, date);
      case 'self_drive':
        return searchDriveMode(deps, from, to, date);
      default: {
        const note = noteFrom(
          'unsupported_capability',
          'none',
          MODE_LABEL[mode] ?? mode,
          `${MODE_LABEL[mode] ?? mode} is possible for this route but no provider is connected for it.`,
        );
        return { ...emptyMode(mode), note, notes: [note] };
      }
    }
  };
  const searches = modes.map(async (mode): Promise<ModeResult> => {
    try {
      return await searchMode(mode);
    } catch (err) {
      const failure = toProviderFailure(err, 'engine', MODE_LABEL[mode] ?? mode);
      const note = noteFromFailure(failure, MODE_CAPABILITY[mode]);
      return { ...emptyMode(mode), note, notes: [note] };
    }
  });

  const settled = await Promise.all(searches);
  const filtered: Array<{ offerId: string; reason: string }> = [];

  for (const result of settled) {
    // Currency first: nothing below may compare a rupee price with another.
    const supported = keepSupportedTransport(
      result.offers.map((o) => o.candidate),
      MODE_CAPABILITY[result.mode],
    );
    notes.push(...supported.notes);
    const { kept, dropped } = applyHardConstraints(supported.kept, constraints, profile, {
      departure: from.timezone,
      arrival: to.timezone,
    });
    filtered.push(...dropped);
    const scored = scoreTransportOffers(kept, profile);

    // Why the mode has nothing to show, if it has nothing. A provider's own
    // explanation comes first; then "everything was in another currency";
    // then "your requirements ruled everything out". The last two are the
    // planner's own words, and are added to the notes here.
    const engineNote: ProviderNote | null =
      result.note !== null
        ? null
        : (supported.kept.length === 0 && result.offers.length > 0 ? (supported.notes[0] ?? null) : null) ??
          (kept.length === 0 && result.offers.length > 0
            ? noteFrom(
                'no_availability',
                'engine',
                MODE_LABEL[result.mode] ?? result.mode,
                `Every ${MODE_LABEL[result.mode] ?? result.mode} option found was ruled out by your requirements.`,
                MODE_CAPABILITY[result.mode],
              )
            : null);
    notes.push(...result.notes);
    if (engineNote && !supported.notes.includes(engineNote)) notes.push(engineNote);

    results.push({
      ...result,
      offers: scored,
      cheapest: pickCheapest(kept),
      fastest: pickFastest(kept),
      bestForYou: scored[0]?.candidate ?? null,
      note: result.note ?? engineNote,
    });
  }

  return { direction, date, modes: results, notes, filtered };
}

/** What each mode's notes are about. */
const MODE_CAPABILITY: Partial<Record<TransportMode, ProviderCapability>> = {
  flight: 'flights',
  train: 'trains',
  bus: 'buses',
  self_drive: 'self_drive',
};

const MODE_LABEL: Record<string, string> = {
  flight: 'Flights',
  train: 'Trains',
  bus: 'Buses',
  self_drive: 'Self-drive',
  rental_car: 'Rental car',
  taxi: 'Private car',
  ferry: 'Ferry',
};

/** A mode nothing is connected for: the registry's own words for what is missing. */
function missingMode(
  registry: ProviderRegistry,
  mode: TransportMode,
  capability: ProviderCapability,
  ids: string[],
): ModeResult {
  const note = noteFromFailure(registry.missingCapabilityNote(capability, ids), capability);
  return { ...emptyMode(mode), note, notes: [note] };
}

/** What a sweep of providers means for one mode. */
function modeFrom<T extends TransportOffer>(
  mode: TransportMode,
  capability: ProviderCapability,
  sweep: { data: T[]; notes: ProviderNote[]; failures: Parameters<typeof primaryFailure>[0] },
): ModeResult {
  const primary = sweep.data.length > 0 ? null : primaryFailure(sweep.failures);
  return {
    ...emptyMode(mode),
    offers: sweep.data.map(asUnscored),
    note: primary ? noteFromFailure(primary, capability) : null,
    notes: sweep.notes,
  };
}

async function searchFlightMode(
  deps: TransportSearchDeps,
  from: Place,
  to: Place,
  date: IsoDate,
): Promise<ModeResult> {
  const { registry, intent, profile, constraints } = deps;
  if (registry.flights.length === 0) return missingMode(registry, 'flight', 'flights', ['amadeus']);

  const [origin, destination] = await Promise.all([
    enrichWithAirports(registry, from, deps.signal),
    enrichWithAirports(registry, to, deps.signal),
  ]);
  const airportNote = origin.note ?? destination.note;
  if (airportNote) return { ...emptyMode('flight'), note: airportNote, notes: [airportNote] };

  const maxStops = findHard(constraints, 'max_stops')?.value ?? profile.transport.maxStops;
  // Only a firm budget asks the provider to filter; a guide leaves every
  // option in the comparison.
  const transportBudget = budgetCeiling(constraints, 'transport');

  const sweep = await sweepProviders(registry, registry.flights, 'flights', 'searchFlights', (provider) =>
    provider.searchFlights({
      origin: origin.place,
      destination: destination.place,
      departureDate: date,
      returnDate: null,
      party: intent.travelers,
      cabinClass: profile.transport.cabinClass,
      maxStops: maxStops ?? null,
      preferredCarriers: profile.transport.preferredCarriers,
      excludedCarriers: profile.transport.avoidedCarriers,
      currency: intent.currency,
      // Ask the provider to filter at source: cheaper for them, faster for us,
      // and it keeps obviously unaffordable inventory out of the comparison.
      maxPrice: transportBudget ? Math.round(toMajor(transportBudget)) : null,
      limit: 20,
      ...(deps.signal ? { signal: deps.signal } : {}),
    }),
  );
  return modeFrom('flight', 'flights', sweep);
}

async function searchRailMode(
  deps: TransportSearchDeps,
  from: Place,
  to: Place,
  date: IsoDate,
): Promise<ModeResult> {
  const { registry, intent } = deps;
  const providers = registry.railFor(from.countryCode);
  if (providers.length === 0) return missingMode(registry, 'train', 'trains', ['rail']);
  const sweep = await sweepProviders(registry, providers, 'trains', 'searchTrains', (provider) =>
    provider.searchTrains({
      origin: from,
      destination: to,
      date,
      party: intent.travelers,
      currency: intent.currency,
      classCode: null,
      limit: 20,
      ...(deps.signal ? { signal: deps.signal } : {}),
    }),
  );
  return modeFrom('train', 'trains', sweep);
}

async function searchBusMode(
  deps: TransportSearchDeps,
  from: Place,
  to: Place,
  date: IsoDate,
): Promise<ModeResult> {
  const { registry, intent } = deps;
  const providers = registry.busesFor(from.countryCode);
  if (providers.length === 0) return missingMode(registry, 'bus', 'buses', ['bus']);
  const sweep = await sweepProviders(registry, providers, 'buses', 'searchBuses', (provider) =>
    provider.searchBuses({
      origin: from,
      destination: to,
      date,
      party: intent.travelers,
      currency: intent.currency,
      classCode: null,
      limit: 20,
      ...(deps.signal ? { signal: deps.signal } : {}),
    }),
  );
  return modeFrom('bus', 'buses', sweep);
}

async function searchDriveMode(
  deps: TransportSearchDeps,
  from: Place,
  to: Place,
  date: IsoDate,
): Promise<ModeResult> {
  const { registry, intent, profile } = deps;
  const selfDrive = registry.selfDrive;
  if (!selfDrive) return missingMode(registry, 'self_drive', 'self_drive', ['osrm', 'google-maps']);
  const sweep = await sweepProviders(registry, [selfDrive], 'self_drive', 'estimate', async (provider) => {
    const res = await provider.estimate({
      origin: from,
      destination: to,
      date,
      departLocalTime: profile.transport.earliestDepartureLocal ?? '08:00',
      currency: intent.currency,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    return isOk(res) ? { ...res, data: [res.data] } : res;
  });
  return modeFrom('self_drive', 'self_drive', sweep);
}

/**
 * Hard constraints are applied as filters, and every drop is recorded with the
 * reason. The traveller can see exactly what their own requirements cost them,
 * which is the only honest way to present "no results".
 */
export function applyHardConstraints(
  offers: TransportOffer[],
  constraints: ConstraintSet,
  profile: TravelerProfile,
  /** Where the leg starts and ends, so time windows are read in local time. */
  zones: LegZones,
): { kept: TransportOffer[]; dropped: Array<{ offerId: string; reason: string }> } {
  const kept: TransportOffer[] = [];
  const dropped: Array<{ offerId: string; reason: string }> = [];
  const maxStops = findHard(constraints, 'max_stops')?.value ?? null;
  const transportBudget = budgetCeiling(constraints, 'transport');
  const requiredBags = findHard(constraints, 'required_checked_bags')?.value ?? 0;
  const needsRefundable = profile.transport.refundableRequired;

  for (const offer of offers) {
    if (maxStops !== null && offer.transfers > maxStops) {
      dropped.push({
        offerId: offer.id,
        reason: `Has ${offer.transfers} change(s); you asked for at most ${maxStops}.`,
      });
      continue;
    }
    if (transportBudget) {
      // A price that cannot be compared with the budget cannot be shown to
      // meet it. Skipping the check, as a currency mismatch used to, would
      // quietly relax a hard constraint.
      const foreign = [offer.totalPrice, ...offer.itemisedFees.map((f) => f.amount)].find(
        (m) => m.currency !== transportBudget.currency,
      );
      if (foreign) {
        dropped.push({
          offerId: offer.id,
          reason: `Priced in ${foreign.currency}, so it cannot be checked against your ${transportBudget.currency} budget.`,
        });
        continue;
      }
      // What the option is known to cost, including separately charged
      // extras, is what has to fit the budget.
      if (compare(knownTransportCost(offer), transportBudget) > 0) {
        dropped.push({
          offerId: offer.id,
          reason: 'Costs more than your firm budget on its own.',
        });
        continue;
      }
    }
    if (needsRefundable && offer.refundable === false) {
      dropped.push({ offerId: offer.id, reason: 'Non-refundable, and you required flexibility.' });
      continue;
    }
    // "No overnight travel" is something the traveller stated, so it filters
    // rather than merely penalises. The drop is recorded, so they can see what
    // the requirement cost them and relax it if the price gap is worth it.
    if (profile.transport.avoidOvernightTravel && offer.overnight) {
      dropped.push({
        offerId: offer.id,
        reason: 'Travels overnight, and you asked to avoid that.',
      });
      continue;
    }
    // Asked for as a safety preference: a filter, like "no overnight travel",
    // so the traveller sees what it cost them and can relax it.
    const lateArrival = profile.transport.avoidRedEyeArrival ? smallHoursArrival(offer, zones) : null;
    if (lateArrival) {
      dropped.push({
        offerId: offer.id,
        reason: `Arrives at ${lateArrival} local time, in the small hours, and you asked to avoid late arrivals.`,
      });
      continue;
    }
    if (requiredBags > 0 && offer.mode === 'flight') {
      const included = offer.fareClasses[0]?.checkedBagsIncluded;
      // A null here means the provider did not state baggage. The offer is
      // kept, because dropping it would hide a real fare, but the gap is
      // recorded so the cost model can flag the unknown rather than assume 0.
      if (included !== null && included !== undefined && included < requiredBags) {
        dropped.push({
          offerId: offer.id,
          reason: `Includes ${included} checked bag(s); you need ${requiredBags}. Add-on pricing is not published for this fare.`,
        });
        continue;
      }
    }
    const timing = timeWindowViolations(offer, constraints, zones);
    if (timing.length > 0) {
      dropped.push({ offerId: offer.id, reason: timing.map((t) => t.reason).join(' ') });
      continue;
    }
    kept.push(offer);
  }
  return { kept, dropped };
}

function pickCheapest(offers: TransportOffer[]): TransportOffer | null {
  if (offers.length === 0) return null;
  return [...offers].sort((a, b) => compare(knownTransportCost(a), knownTransportCost(b)))[0]!;
}

function pickFastest(offers: TransportOffer[]): TransportOffer | null {
  if (offers.length === 0) return null;
  return [...offers].sort((a, b) => a.totalDurationMinutes - b.totalDurationMinutes)[0]!;
}

function emptyMode(mode: TransportMode): ModeResult {
  return { mode, offers: [], cheapest: null, fastest: null, bestForYou: null, note: null, notes: [] };
}

function asUnscored(offer: TransportOffer): ScoredCandidate<TransportOffer> {
  return { candidate: offer, score: 0, breakdown: {} };
}
