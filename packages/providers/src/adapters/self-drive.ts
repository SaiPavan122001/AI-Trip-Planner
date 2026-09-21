import {
  divide,
  fail,
  money,
  ok,
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

    const departureAt = `${opts.date}T${opts.departLocalTime}:00`;
    const route = await this.routing.route({
      from: opts.origin.coordinates,
      to: opts.destination.coordinates,
      profile: 'driving',
      departAt: new Date(departureAt).toISOString(),
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

    const warnings: string[] = [];
    let total = null as ReturnType<typeof money> | null;
    if (profile) {
      const energy = (distanceKm / 100) * profile.consumptionPer100Km * profile.energyPrice;
      const wear = distanceKm * profile.perKmAllowance;
      total = money(energy + wear, profile.currency);
      warnings.push(
        'Tolls, parking and fines are not included: no toll data source is configured for this route.',
      );
    } else {
      warnings.push(
        'No vehicle profile is configured (SELF_DRIVE_PROFILE), so this drive is shown with distance and time only, without a cost.',
      );
    }

    const arrivalAt = new Date(Date.parse(departureAt) + totalMinutes * 60_000).toISOString();

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
      totalPrice: total ?? money(0, opts.currency),
      pricePerTraveler: total
        ? divide(total, Math.max(1, profile?.averageOccupancy ?? 1))
        : money(0, opts.currency),
      itemisedFees: [],
      fareClasses: [],
      selectedFareCode: null,
      totalDurationMinutes: totalMinutes,
      transfers: 0,
      overnight: departureAt.slice(0, 10) !== arrivalAt.slice(0, 10),
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
        attribution: profile
          ? `Cost modelled from the configured vehicle profile: ${profile.consumptionPer100Km}/100km at ${profile.energyPrice}/unit plus ${profile.perKmAllowance}/km wear`
          : null,
      },
    };

    return ok(offer, offer.provenance, warnings);
  }
}
