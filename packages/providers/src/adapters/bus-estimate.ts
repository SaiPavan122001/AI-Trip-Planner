import {
  addMinutes,
  fail,
  isoWithOffset,
  localParts,
  money,
  ok,
  utcFromLocal,
  type ProviderResult,
  type TransportOffer,
} from '@trip/shared';
import type { BusProvider, ProviderDescriptor, RoutingProvider, SurfaceSearchRequest } from '../types.js';

/**
 * A bus FARE ESTIMATE, not a bus search.
 *
 * No approved live bus inventory is connected, so this does not know of any
 * bus. It answers one question: roughly what would the fare for this distance
 * be, if the operator who configured the assumptions is right. The distance
 * comes from a routing provider; everything else comes from a fare model the
 * operator supplies (`BUS_FARE_ESTIMATE`), which names its own source and the
 * date it was last checked. Nothing here is invented: with no model configured
 * the provider is off and buses are reported as not searched.
 *
 * What an offer does and does not say:
 *  - It names no operator and no service, and states no seat availability.
 *  - Its departure time is a planning assumption (the configured local time),
 *    not a timetable, and the offer says so.
 *  - Its price is marked as an estimate, with the assumptions behind it.
 *  - It cannot be re-priced or booked: it has no revalidation token.
 *
 * A real bus provider (the generic surface-transport contract) replaces it: it
 * is registered only while none is configured, and nothing else changes.
 */

export interface BusFareCategory {
  label: string;
  perKm: number;
  /** Door-to-door average speed for this kind of service, km/h. */
  averageSpeedKmh: number;
  minimumFare: number;
}

export interface BusFareModel {
  currency: string;
  /** Where the numbers come from, in the operator's words. */
  source: string;
  /** The date the numbers were last checked, YYYY-MM-DD. */
  asOf: string;
  baseFare: number;
  categories: Record<string, BusFareCategory>;
  /** Local time of day the estimate assumes the journey starts at. */
  assumedDepartureTime: string;
}

const DESCRIPTOR: ProviderDescriptor = {
  id: 'bus-estimate',
  label: 'Bus fare estimate (configured assumptions, not a timetable or a quote)',
  kinds: ['bus'],
  requiredEnv: ['BUS_FARE_ESTIMATE'],
  coverage: ['IN'],
  docsUrl: null,
  attribution: null,
};

export class BusEstimateProvider implements BusProvider {
  readonly descriptor = DESCRIPTOR;

  constructor(
    private readonly routing: RoutingProvider,
    private readonly model: BusFareModel,
  ) {}

  isConfigured(): boolean {
    return this.routing.isConfigured();
  }

  async health(): Promise<ProviderResult<{ ok: true; latencyMs: number }>> {
    return this.routing.health();
  }

  async searchBuses(req: SurfaceSearchRequest): Promise<ProviderResult<TransportOffer[]>> {
    if (!this.routing.isConfigured()) {
      return fail(
        'not_configured',
        DESCRIPTOR.id,
        DESCRIPTOR.label,
        'A routing provider is needed to measure the distance for a bus fare estimate. Set OSRM_BASE_URL or GOOGLE_MAPS_API_KEY.',
      );
    }
    if (req.currency !== this.model.currency) {
      return fail(
        'unsupported_route',
        DESCRIPTOR.id,
        DESCRIPTOR.label,
        `The bus fare assumptions are in ${this.model.currency}, not ${req.currency}, so no estimate was made.`,
      );
    }

    const departUtc = utcFromLocal(req.date, this.model.assumedDepartureTime, req.origin.timezone);
    const route = await this.routing.route({
      from: req.origin.coordinates,
      to: req.destination.coordinates,
      profile: 'driving',
      departAt: departUtc,
    });
    if (route.status !== 'ok') return route;

    const distanceKm = route.data.distanceKm;
    const payingTravellers = Math.max(1, req.party.adults + req.party.children);
    const m = this.model;
    const basisBase = `Estimated from configured assumptions (${m.source}, last checked ${m.asOf}) over ${Math.round(distanceKm)} km of road`;
    const only = req.classCode ? [req.classCode] : Object.keys(m.categories);

    const offers: TransportOffer[] = [];
    for (const code of only) {
      const category = m.categories[code];
      if (!category) continue;
      const perPerson = Math.max(category.minimumFare, m.baseFare + category.perKm * distanceKm);
      const total = money(perPerson * payingTravellers, m.currency);
      const minutes = Math.max(1, Math.round((distanceKm / category.averageSpeedKmh) * 60));
      const arriveUtc = addMinutes(departUtc, minutes);
      const label = `${category.label} (estimated fare)`;

      offers.push({
        id: `bus-estimate:${req.origin.id}-${req.destination.id}-${req.date}:${code}`,
        mode: 'bus',
        segments: [
          {
            mode: 'bus',
            operatorCode: null,
            operatorName: null,
            serviceNumber: null,
            // No bus stand is known, so no position is given for either end: the city's
            // centre is not where a bus leaves from, and must not be planned as if it were.
            origin: { code: null, name: req.origin.name, coordinates: null, timezone: req.origin.timezone, terminal: null },
            destination: { code: null, name: req.destination.name, coordinates: null, timezone: req.destination.timezone, terminal: null },
            departureAt: isoWithOffset(departUtc, req.origin.timezone),
            arrivalAt: isoWithOffset(arriveUtc, req.destination.timezone),
            durationMinutes: minutes,
            vehicleType: null,
          },
        ],
        totalPrice: total,
        pricePerTraveler: money(perPerson, m.currency),
        itemisedFees: [
          {
            label: 'Estimated bus fare',
            amount: total,
            // Already the whole fare; it is itemised only to carry the label and its basis.
            included: true,
            isEstimate: true,
            basis: `${basisBase}: ${m.baseFare} + ${category.perKm}/km, at least ${category.minimumFare} each, for ${payingTravellers} paying traveller(s)`,
          },
        ],
        unpricedCosts: [],
        fareClasses: [
          {
            code,
            label,
            cabin: null,
            price: total,
            availability: null,
            availabilityLabel: 'Not known: no bus service is confirmed by this estimate',
            refundable: null,
            checkedBagsIncluded: null,
            cabinBagKg: null,
          },
        ],
        selectedFareCode: code,
        totalDurationMinutes: minutes,
        transfers: 0,
        overnight:
          localParts(departUtc, req.origin.timezone).date !== localParts(arriveUtc, req.destination.timezone).date,
        refundable: null,
        cancellationPolicy: null,
        baggageSummary: null,
        revalidationToken: null,
        provenance: {
          provider: DESCRIPTOR.id,
          providerLabel: DESCRIPTOR.label,
          retrievedAt: new Date().toISOString(),
          validUntil: null,
          searchId: null,
          attribution: null,
        },
      });
    }

    if (offers.length === 0) {
      return fail('no_availability', DESCRIPTOR.id, DESCRIPTOR.label, 'No bus fare category matched this search, so no estimate was made.');
    }
    return ok(offers, offers[0]!.provenance, [
      `Bus fares here are estimates from configured assumptions (${m.source}, last checked ${m.asOf}), not quotes. No operator, timetable or seat availability is known; the ${m.assumedDepartureTime} start is a planning assumption. Actual fares vary by operator.`,
      ...route.warnings,
    ]);
  }
}
