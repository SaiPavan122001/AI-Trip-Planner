import type { ProviderRegistry } from '@trip/providers';
import {
  compare,
  findHard,
  isOk,
  toMajor,
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
import { keepSupportedTransport } from './currency.js';
import { knownTransportCost } from './pricing.js';
import { timeWindowViolations, type LegZones } from './time-windows.js';
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
}

function noteFrom(status: string, provider: string, label: string, message: string): ProviderNote {
  return {
    provider,
    providerLabel: label,
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
      ),
    };
  }
  const res = await amadeus.nearestAirports(place.coordinates);
  if (!isOk(res)) {
    return {
      place,
      note: noteFrom(res.status, res.provider, res.providerLabel, res.message),
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

  const searches = modes.map(async (mode): Promise<ModeResult> => {
    switch (mode) {
      case 'flight':
        return searchFlightMode(deps, from, to, date);
      case 'train':
        return searchRailMode(deps, from, to, date);
      case 'bus':
        return searchBusMode(deps, from, to, date);
      case 'self_drive':
        return searchDriveMode(deps, from, to, date);
      default:
        return {
          mode,
          offers: [],
          cheapest: null,
          fastest: null,
          bestForYou: null,
          note: noteFrom(
            'unsupported_capability',
            'none',
            MODE_LABEL[mode] ?? mode,
            `${MODE_LABEL[mode] ?? mode} is possible for this route but no provider is connected for it.`,
          ),
        };
    }
  });

  const settled = await Promise.all(searches);
  const filtered: Array<{ offerId: string; reason: string }> = [];

  for (const result of settled) {
    // Currency first: nothing below may compare a rupee price with another.
    const supported = keepSupportedTransport(result.offers.map((o) => o.candidate));
    notes.push(...supported.notes);
    const { kept, dropped } = applyHardConstraints(supported.kept, constraints, profile, {
      departure: from.timezone,
      arrival: to.timezone,
    });
    filtered.push(...dropped);
    const scored = scoreTransportOffers(kept, profile);
    const enriched: ModeResult = {
      ...result,
      offers: scored,
      cheapest: pickCheapest(kept),
      fastest: pickFastest(kept),
      bestForYou: scored[0]?.candidate ?? null,
      note:
        result.note ??
        // Everything this mode returned was in another currency: say that,
        // not that the traveller's requirements ruled it out.
        (supported.kept.length === 0 && result.offers.length > 0 ? (supported.notes[0] ?? null) : null) ??
        (kept.length === 0 && result.offers.length > 0
          ? noteFrom(
              'no_availability',
              'engine',
              MODE_LABEL[result.mode] ?? result.mode,
              `Every ${MODE_LABEL[result.mode] ?? result.mode} option found was ruled out by your requirements.`,
            )
          : null),
    };
    if (enriched.note) notes.push(enriched.note);
    results.push(enriched);
  }

  return { direction, date, modes: results, notes, filtered };
}

const MODE_LABEL: Record<string, string> = {
  flight: 'Flights',
  train: 'Trains',
  bus: 'Buses',
  self_drive: 'Self-drive',
  rental_car: 'Rental car',
  taxi: 'Private car',
  ferry: 'Ferry',
};

async function searchFlightMode(
  deps: TransportSearchDeps,
  from: Place,
  to: Place,
  date: IsoDate,
): Promise<ModeResult> {
  const { registry, intent, profile, constraints } = deps;
  const empty = emptyMode('flight');
  if (registry.flights.length === 0) {
    return { ...empty, note: fromFailure(registry.missingCapabilityNote('Flights', ['amadeus'])) };
  }

  const [origin, destination] = await Promise.all([
    enrichWithAirports(registry, from),
    enrichWithAirports(registry, to),
  ]);
  if (origin.note) return { ...empty, note: origin.note };
  if (destination.note) return { ...empty, note: destination.note };

  const maxStops = findHard(constraints, 'max_stops')?.value ?? profile.transport.maxStops;
  const transportBudget = constraints.budget.transport;

  const all: TransportOffer[] = [];
  let lastNote: ProviderNote | null = null;

  for (const provider of registry.flights) {
    const res = await provider.searchFlights({
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
    });
    if (isOk(res)) all.push(...res.data);
    else lastNote = fromFailure(res);
  }

  return { ...emptyMode('flight'), offers: all.map(asUnscored), note: all.length ? null : lastNote };
}

async function searchRailMode(
  deps: TransportSearchDeps,
  from: Place,
  to: Place,
  date: IsoDate,
): Promise<ModeResult> {
  const { registry, intent } = deps;
  const providers = registry.railFor(from.countryCode);
  if (providers.length === 0) {
    return {
      ...emptyMode('train'),
      note: fromFailure(registry.missingCapabilityNote('Trains', ['rail'])),
    };
  }
  const all: TransportOffer[] = [];
  let lastNote: ProviderNote | null = null;
  for (const provider of providers) {
    const res = await provider.searchTrains({
      origin: from,
      destination: to,
      date,
      party: intent.travelers,
      currency: intent.currency,
      classCode: null,
      limit: 20,
    });
    if (isOk(res)) all.push(...res.data);
    else lastNote = fromFailure(res);
  }
  return { ...emptyMode('train'), offers: all.map(asUnscored), note: all.length ? null : lastNote };
}

async function searchBusMode(
  deps: TransportSearchDeps,
  from: Place,
  to: Place,
  date: IsoDate,
): Promise<ModeResult> {
  const { registry, intent } = deps;
  const providers = registry.busesFor(from.countryCode);
  if (providers.length === 0) {
    return {
      ...emptyMode('bus'),
      note: fromFailure(registry.missingCapabilityNote('Buses', ['bus'])),
    };
  }
  const all: TransportOffer[] = [];
  let lastNote: ProviderNote | null = null;
  for (const provider of providers) {
    const res = await provider.searchBuses({
      origin: from,
      destination: to,
      date,
      party: intent.travelers,
      currency: intent.currency,
      classCode: null,
      limit: 20,
    });
    if (isOk(res)) all.push(...res.data);
    else lastNote = fromFailure(res);
  }
  return { ...emptyMode('bus'), offers: all.map(asUnscored), note: all.length ? null : lastNote };
}

async function searchDriveMode(
  deps: TransportSearchDeps,
  from: Place,
  to: Place,
  date: IsoDate,
): Promise<ModeResult> {
  const { registry, intent, profile } = deps;
  const selfDrive = registry.selfDrive;
  if (!selfDrive) {
    return {
      ...emptyMode('self_drive'),
      note: fromFailure(registry.missingCapabilityNote('Self-drive', ['osrm', 'google-maps'])),
    };
  }
  const res = await selfDrive.estimate({
    origin: from,
    destination: to,
    date,
    departLocalTime: profile.transport.earliestDepartureLocal ?? '08:00',
    currency: intent.currency,
  });
  if (!isOk(res)) return { ...emptyMode('self_drive'), note: fromFailure(res) };
  return { ...emptyMode('self_drive'), offers: [asUnscored(res.data)] };
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
  const transportBudget = constraints.budget.transport;
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
          reason: 'Costs more than the transport budget on its own.',
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
  return { mode, offers: [], cheapest: null, fastest: null, bestForYou: null, note: null };
}

function asUnscored(offer: TransportOffer): ScoredCandidate<TransportOffer> {
  return { candidate: offer, score: 0, breakdown: {} };
}

function fromFailure(f: {
  status: string;
  provider: string;
  providerLabel: string;
  message: string;
}): ProviderNote {
  return noteFrom(f.status, f.provider, f.providerLabel, f.message);
}
