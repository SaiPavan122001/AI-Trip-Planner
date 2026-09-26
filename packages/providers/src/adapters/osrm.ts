import {
  fail,
  localParts,
  money,
  multiply,
  ok,
  seatedTravelers,
  type ProviderResult,
  type TransferOffer,
} from '@trip/shared';
import { httpJson, RequestPacer, toProviderFailure } from '../http.js';
import { readResponse } from '../guard.js';
import { OsrmRouteResponse } from '../schemas.js';
import type {
  GroundTransportProvider,
  ProviderDescriptor,
  RouteRequest,
  RouteResult,
  RoutingProvider,
  TransferSearchRequest,
} from '../types.js';

/**
 * OSRM gives distance and duration for road journeys with no credentials,
 * which covers self-drive legs and the geometry of airport transfers. It does
 * not know about traffic or fares, and this adapter never pretends otherwise.
 */

/** Passengers one car carries. A larger party is priced as several cars, not one. */
export const TAXI_SEATS = 4;

const ROUTING_DESCRIPTOR: ProviderDescriptor = {
  id: 'osrm',
  label: 'OSRM routing',
  kinds: ['routing'],
  requiredEnv: ['OSRM_BASE_URL'],
  coverage: 'global',
  docsUrl: 'http://project-osrm.org/docs/v5.24.0/api/',
  attribution: 'Routing © OSRM, map data © OpenStreetMap contributors (ODbL)',
};

export interface OsrmConfig {
  baseUrl: string;
  minIntervalMs: number;
}

export class OsrmRoutingProvider implements RoutingProvider {
  readonly descriptor = ROUTING_DESCRIPTOR;
  private readonly pacer: RequestPacer;

  constructor(private readonly config: OsrmConfig) {
    this.pacer = new RequestPacer(config.minIntervalMs);
  }

  isConfigured(): boolean {
    return Boolean(this.config.baseUrl);
  }

  async health(): Promise<ProviderResult<{ ok: true; latencyMs: number }>> {
    const started = Date.now();
    const res = await this.route({
      from: { lat: 48.8566, lon: 2.3522 },
      to: { lat: 48.8584, lon: 2.2945 },
      profile: 'driving',
    });
    if (res.status !== 'ok') return res;
    return ok({ ok: true as const, latencyMs: Date.now() - started }, res.provenance);
  }

  async route(req: RouteRequest): Promise<ProviderResult<RouteResult>> {
    if (!this.isConfigured()) {
      return fail('not_configured', ROUTING_DESCRIPTOR.id, ROUTING_DESCRIPTOR.label, 'Set OSRM_BASE_URL to enable road routing.');
    }
    const coords = `${req.from.lon},${req.from.lat};${req.to.lon},${req.to.lat}`;
    try {
      const raw = await this.pacer.run(() =>
        httpJson<unknown>(`${this.config.baseUrl}/route/v1/${req.profile}/${coords}`, {
          query: { overview: 'simplified', geometries: 'polyline', alternatives: false },
          ...(req.signal ? { signal: req.signal } : {}),
        }),
      );
      const res = readResponse(OsrmRouteResponse, raw, 'route');
      const route = res.routes?.[0];
      if (res.code !== 'Ok' || !route) {
        return fail(
          'unsupported_route',
          ROUTING_DESCRIPTOR.id,
          ROUTING_DESCRIPTOR.label,
          'No road route exists between these points, so a drive cannot be planned for this leg.',
        );
      }
      return ok(
        {
          distanceKm: Number((route.distance / 1000).toFixed(2)),
          durationMinutes: Math.round(route.duration / 60),
          geometry: route.geometry ?? null,
        },
        provenance(ROUTING_DESCRIPTOR),
      );
    } catch (err) {
      return toProviderFailure(err, ROUTING_DESCRIPTOR.id, ROUTING_DESCRIPTOR.label);
    }
  }
}

const TRANSFER_DESCRIPTOR: ProviderDescriptor = {
  id: 'osrm-transfer',
  label: 'Road transfer estimate (OSRM)',
  kinds: ['ground_transport'],
  requiredEnv: ['OSRM_BASE_URL'],
  coverage: 'global',
  docsUrl: 'http://project-osrm.org/docs/v5.24.0/api/',
  attribution: 'Routing © OSRM, map data © OpenStreetMap contributors (ODbL)',
};

export interface TaxiTariff {
  currency: string;
  /** Flag-down charge in major units. */
  baseFare: number;
  perKm: number;
  perMinute: number;
  /** Multiplier applied between 22:00 and 05:00 local time. */
  nightMultiplier: number;
}

/**
 * Turns a road route into a transfer option. Distance and duration are real,
 * measured values; the fare is only ever produced from an operator-configured
 * tariff and is always returned with `priceIsEstimate` set and the tariff named
 * as its basis. With no tariff configured the price stays null and the UI shows
 * the leg without a number rather than inventing one.
 */
export class OsrmTransferProvider implements GroundTransportProvider {
  readonly descriptor = TRANSFER_DESCRIPTOR;

  constructor(
    private readonly routing: OsrmRoutingProvider,
    private readonly tariffs: Record<string, TaxiTariff>,
  ) {}

  isConfigured(): boolean {
    return this.routing.isConfigured();
  }

  async health(): Promise<ProviderResult<{ ok: true; latencyMs: number }>> {
    return this.routing.health();
  }

  async searchTransfers(req: TransferSearchRequest): Promise<ProviderResult<TransferOffer[]>> {
    const driving = await this.routing.route({
      from: req.from.coordinates,
      to: req.to.coordinates,
      profile: 'driving',
    });
    if (driving.status !== 'ok') return driving;

    const { distanceKm, durationMinutes } = driving.data;
    const tariff = this.tariffs[req.currency];
    const offers: TransferOffer[] = [];
    const warnings: string[] = [];

    // Cars for the whole party, not one car for any number of people.
    const vehicles = Math.max(1, Math.ceil(seatedTravelers(req.party) / TAXI_SEATS));
    const perCar = tariff ? estimateFare(tariff, distanceKm, durationMinutes, req.at, req.timezone) : null;
    const price = perCar ? multiply(perCar, vehicles) : null;
    if (!tariff) {
      warnings.push(
        'No taxi fare is available for this transfer, so it is shown with its distance and time and listed as not included in the total.',
      );
    }

    offers.push({
      id: `osrm-taxi:${hashLeg(req)}`,
      mode: 'taxi',
      from: req.from,
      to: req.to,
      distanceKm,
      durationMinutes,
      vehicles,
      price,
      priceIsEstimate: price !== null,
      estimateBasis: tariff
        ? `Configured ${req.currency} tariff: base ${tariff.baseFare} + ${tariff.perKm}/km + ${tariff.perMinute}/min${vehicles > 1 ? `, for ${vehicles} cars` : ''}`
        : null,
      accessible: null,
      provenance: provenance(TRANSFER_DESCRIPTOR),
    });

    // Walking is only a genuine option for short, luggage-light legs.
    if (distanceKm <= 1.5 && req.luggagePieces <= 2) {
      const walking = await this.routing.route({
        from: req.from.coordinates,
        to: req.to.coordinates,
        profile: 'walking',
      });
      if (walking.status === 'ok') {
        offers.push({
          id: `osrm-walk:${hashLeg(req)}`,
          mode: 'walk',
          from: req.from,
          to: req.to,
          distanceKm: walking.data.distanceKm,
          durationMinutes: walking.data.durationMinutes,
          vehicles: 1,
          price: money(0, req.currency),
          priceIsEstimate: false,
          estimateBasis: null,
          accessible: null,
          provenance: provenance(TRANSFER_DESCRIPTOR),
        });
      }
    }

    if (req.accessibleRequired) {
      warnings.push(
        'Wheelchair-accessible vehicle availability is not published by this routing source. Confirm with the operator before relying on it.',
      );
    }

    return ok(offers, provenance(TRANSFER_DESCRIPTOR), warnings);
  }
}

function estimateFare(
  tariff: TaxiTariff,
  distanceKm: number,
  durationMinutes: number,
  at: string,
  timezone: string,
) {
  // The night tariff follows the clock where the ride happens. `Date#getHours`
  // would read the clock of whatever machine the planner runs on.
  const hour = localParts(at, timezone).hour;
  const night = hour >= 22 || hour < 5;
  const base = tariff.baseFare + tariff.perKm * distanceKm + tariff.perMinute * durationMinutes;
  return money(base * (night ? tariff.nightMultiplier : 1), tariff.currency);
}

function hashLeg(req: TransferSearchRequest): string {
  const raw = `${req.from.coordinates.lat},${req.from.coordinates.lon}->${req.to.coordinates.lat},${req.to.coordinates.lon}@${req.at}`;
  let h = 0;
  for (let i = 0; i < raw.length; i += 1) h = (h * 31 + raw.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function provenance(d: ProviderDescriptor) {
  return {
    provider: d.id,
    providerLabel: d.label,
    retrievedAt: new Date().toISOString(),
    validUntil: null,
    searchId: null,
    attribution: d.attribution,
  };
}
