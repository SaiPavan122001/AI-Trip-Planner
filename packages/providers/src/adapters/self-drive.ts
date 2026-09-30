import {
  addMinutes,
  fail,
  isoWithOffset,
  localParts,
  money,
  ok,
  utcFromLocal,
  type IsoDate,
  type Place,
  type ProviderResult,
  type TransportOffer,
} from '@trip/shared';
import type { BaseProvider, ProviderDescriptor, RoutingProvider } from '../types.js';

/**
 * Self-drive is the one transport mode with no inventory to search: the car
 * already exists, so the question is only how far, how long, and what it costs
 * to run. Distance and duration come from a routing provider (real, measured);
 * the running cost is computed from an operator-configured vehicle profile and
 * is always marked as an estimate with its basis spelled out.
 *
 * Tolls are deliberately not guessed. When no toll source is configured the
 * offer says so, because a silent zero would understate an Indian expressway
 * or a French autoroute by a lot.
 */

const DESCRIPTOR: ProviderDescriptor = {
  id: 'self-drive',
  label: 'Self-drive estimate',
  kinds: ['ground_transport'],
  requiredEnv: ['SELF_DRIVE_PROFILE'],
  coverage: 'global',
  docsUrl: null,
  attribution: null,
};

export interface VehicleProfile {
  currency: string;
  /** Litres or kWh per 100km. */
  consumptionPer100Km: number;
  /** Price per litre or kWh in major units. */
  energyPrice: number;
  /** Wear-and-tear allowance per km, in major units. */
  perKmAllowance: number;
  /** Hours a driver should not exceed before a rest stop. */
  maxDrivingHoursBeforeBreak: number;
  breakMinutes: number;
  averageOccupancy: number;
}

export interface SelfDriveOptions {
  origin: Place;
  destination: Place;
  date: IsoDate;
  /** Local departure time, defaults to 08:00 when the traveller has no view. */
  departLocalTime: string;
  /** Currency the trip is costed in; a drive with no profile is still summed. */
  currency: string;
  signal?: AbortSignal;
}

export class SelfDriveProvider implements BaseProvider {
  readonly descriptor = DESCRIPTOR;

  constructor(
    private readonly routing: RoutingProvider,
    private readonly profile: VehicleProfile | null,
  ) {}

  isConfigured(): boolean {
    return this.routing.isConfigured();
  }

  async health(): Promise<ProviderResult<{ ok: true; latencyMs: number }>> {
    return this.routing.health();
  }

  async estimate(opts: SelfDriveOptions): Promise<ProviderResult<TransportOffer>> {
    if (!this.routing.isConfigured()) {
      return fail(
        'not_configured',
        DESCRIPTOR.id,
        DESCRIPTOR.label,
        'A routing provider is required to estimate a drive. Set OSRM_BASE_URL or GOOGLE_MAPS_API_KEY.',
      );
    }

    if (!/^\d{2}:\d{2}$/.test(opts.departLocalTime)) {
      return fail(
        'invalid_request',
        DESCRIPTOR.id,
        DESCRIPTOR.label,
        'The departure time for this drive is not a valid time of day.',
      );
    }

    // The departure is a wall-clock time where the traveller starts, so it is
    // resolved in the origin's zone. Parsing it with `new Date()` would use
    // whatever zone the server happens to run in.
    const departUtc = utcFromLocal(opts.date, opts.departLocalTime, opts.origin.timezone);
    const route = await this.routing.route({
      from: opts.origin.coordinates,
      to: opts.destination.coordinates,
      profile: 'driving',
      departAt: departUtc,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (route.status !== 'ok') return route;

    const { distanceKm, durationMinutes } = route.data;
    const profile = this.profile;

    // Long drives get mandatory rest built into the duration. An eight-hour
    // "estimate" that assumes nobody stops is not a plan anybody can execute.
    const breaks = profile
      ? Math.max(0, Math.floor(durationMinutes / 60 / profile.maxDrivingHoursBeforeBreak))
      : Math.max(0, Math.floor(durationMinutes / 60 / 3));
    const breakMinutes = breaks * (profile?.breakMinutes ?? 30);
    const totalMinutes = durationMinutes + breakMinutes;

    // Driving your own car has no fare: nobody sells you a ticket, so the
    // transport cost is a known ₹0. What it does cost is shown separately,
    // and only where it can be calculated. Fuel and wear come from the
    // operator's configured vehicle profile, as labelled estimates; tolls and
    // parking have no data source, so they are named as not calculated
    // rather than counted as zero.
    // What the routing source said about itself comes first: which provider
    // measured the drive, and (when a preferred one failed and another answered)
    // what went wrong, so a degraded answer is never presented as an ordinary one.
    const warnings: string[] = [`Distance and time come from ${route.provenance.providerLabel}.`, ...route.warnings];
    const itemisedFees: TransportOffer['itemisedFees'] = [];
    const unpricedCosts: string[] = [];
    if (profile) {
      const basis = `Estimated from the configured vehicle profile over ${Math.round(distanceKm)} km`;
      const fuel = money((distanceKm / 100) * profile.consumptionPer100Km * profile.energyPrice, profile.currency);
      itemisedFees.push({
        label: 'Fuel',
        amount: fuel,
        included: false,
        isEstimate: true,
        basis: `${basis}: ${profile.consumptionPer100Km} per 100 km at ${profile.energyPrice} per unit`,
      });
      if (profile.perKmAllowance > 0) {
        itemisedFees.push({
          label: 'Wear and tear',
          amount: money(distanceKm * profile.perKmAllowance, profile.currency),
          included: false,
          isEstimate: true,
          basis: `${basis}: ${profile.perKmAllowance} per km`,
        });
      }
    } else {
      unpricedCosts.push('Fuel', 'Wear and tear');
      warnings.push(
        'Fuel and wear are not calculated for this drive because no vehicle profile is configured.',
      );
    }
    unpricedCosts.push('Tolls', 'Parking');
    warnings.push('Tolls and parking are not calculated: no source for them is connected.');

    // Arithmetic on the instant, then each end written as local wall time in
    // its own zone with its offset, the same shape every other transport
    // segment uses. A drive across a zone boundary arrives in the
    // destination's local time, not the origin's.
    const arriveUtc = addMinutes(departUtc, totalMinutes);
    const departureAt = isoWithOffset(departUtc, opts.origin.timezone);
    const arrivalAt = isoWithOffset(arriveUtc, opts.destination.timezone);
    const overnight =
      localParts(departUtc, opts.origin.timezone).date !==
      localParts(arriveUtc, opts.destination.timezone).date;

    const offer: TransportOffer = {
      id: `self-drive:${opts.origin.id}-${opts.destination.id}-${opts.date}`,
      mode: 'self_drive',
      segments: [
        {
          mode: 'self_drive',
          operatorCode: null,
          operatorName: null,
          serviceNumber: null,
          origin: {
            code: null,
            name: opts.origin.name,
            coordinates: opts.origin.coordinates,
            timezone: opts.origin.timezone,
            terminal: null,
          },
          destination: {
            code: null,
            name: opts.destination.name,
            coordinates: opts.destination.coordinates,
            timezone: opts.destination.timezone,
            terminal: null,
          },
          departureAt,
          arrivalAt,
          durationMinutes: totalMinutes,
          vehicleType: 'own_vehicle',
        },
      ],
      totalPrice: money(0, opts.currency),
      pricePerTraveler: money(0, opts.currency),
      itemisedFees,
      unpricedCosts,
      fareClasses: [],
      selectedFareCode: null,
      totalDurationMinutes: totalMinutes,
      transfers: 0,
      overnight,
      refundable: null,
      cancellationPolicy: null,
      baggageSummary: 'Limited only by the vehicle',
      revalidationToken: null,
      provenance: {
        provider: DESCRIPTOR.id,
        providerLabel: DESCRIPTOR.label,
        retrievedAt: new Date().toISOString(),
        validUntil: null,
        searchId: null,
        attribution: null,
      },
    };

    return ok(offer, offer.provenance, warnings);
  }
}
