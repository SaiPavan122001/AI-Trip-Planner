import { z } from 'zod';
import {
  fail,
  money,
  ok,
  type ProviderProvenance,
  type ProviderResult,
  type TransportOffer,
} from '@trip/shared';
import { httpJson, RequestPacer, toProviderFailure } from '../http.js';
import { droppedWarning, readItems } from '../guard.js';
import type {
  BusProvider,
  ProviderDescriptor,
  RailProvider,
  SurfaceSearchRequest,
} from '../types.js';

/**
 * Rail and bus inventory has no global open API, and the operators that do
 * expose one (Indian Railways, RedBus, Trainline, Deutsche Bahn, ...) require
 * a commercial agreement per deployment. Rather than ship an adapter that
 * cannot legally run, this module speaks one small documented contract over
 * HTTP: point it at a service you are authorised to use and it becomes a real
 * provider. See docs/providers.md for the request and response schema.
 *
 * Until an endpoint is configured, every search returns `not_configured` and
 * the UI says so. It never falls back to a plausible-looking timetable.
 */

const RemoteFare = z.object({
  code: z.string(),
  label: z.string(),
  priceMajor: z.number().nonnegative(),
  availability: z.number().int().nullable().optional(),
  availabilityLabel: z.string().nullable().optional(),
  refundable: z.boolean().nullable().optional(),
});

/** ISO 8601 with an offset ("+05:30" or "Z"): a bare local time cannot be checked against connections. */
const OffsetDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/, 'a timestamp with a UTC offset')
  .refine((v) => Number.isFinite(Date.parse(v)), 'not a real timestamp');

const RemoteLeg = z.object({
  operatorCode: z.string().nullable().optional(),
  operatorName: z.string().nullable().optional(),
  serviceNumber: z.string().nullable().optional(),
  originName: z.string(),
  originCode: z.string().nullable().optional(),
  destinationName: z.string(),
  destinationCode: z.string().nullable().optional(),
  /** ISO 8601 with offset. The offset is required: a bare local time cannot be
   *  validated against connections or check-in times. */
  departureAt: OffsetDateTime,
  arrivalAt: OffsetDateTime,
  durationMinutes: z.number().int().positive(),
  vehicleType: z.string().nullable().optional(),
});

const RemoteService = z
  .object({
    id: z.string(),
    legs: z.array(RemoteLeg).min(1),
    currency: z.string().length(3),
    /** Fare classes exactly as the operator names them: "3A", "SL", "Sleeper AC". */
    fares: z.array(RemoteFare).min(1),
    transfers: z.number().int().min(0).default(0),
    cancellationPolicy: z.string().nullable().optional(),
    baggageSummary: z.string().nullable().optional(),
    revalidationToken: z.string().nullable().optional(),
  })
  // A service that arrives before it leaves is not a service.
  .refine(
    (s) => s.legs.every((l) => Date.parse(l.arrivalAt) > Date.parse(l.departureAt)),
    'a leg arrives before it departs',
  );

const RemoteResponse = z.object({
  /** Each service is checked on its own, so one bad row does not discard the rest. */
  services: z.array(z.unknown()),
  /** Operator-reported validity of these prices, if any. */
  validUntil: z.string().nullable().optional(),
  searchId: z.string().nullable().optional(),
  warnings: z.array(z.string()).default([]),
});

export interface GenericSurfaceConfig {
  /** Base URL of the service implementing the contract. */
  baseUrl: string;
  apiKey: string | null;
  /** ISO 3166-1 alpha-2 codes this operator serves, or 'global'. */
  coverage: 'global' | string[];
  label: string;
  /** Env var names quoted back to the operator when unconfigured. */
  requiredEnv: string[];
  attribution: string | null;
  minIntervalMs: number;
  timeoutMs: number;
}

abstract class GenericSurfaceProvider {
  readonly descriptor: ProviderDescriptor;
  private readonly pacer: RequestPacer;

  protected constructor(
    id: string,
    kind: 'rail' | 'bus',
    protected readonly config: GenericSurfaceConfig,
    private readonly path: string,
  ) {
    this.descriptor = {
      id,
      label: config.label,
      kinds: [kind],
      requiredEnv: config.requiredEnv,
      coverage: config.coverage,
      docsUrl: null,
      attribution: config.attribution,
    };
    this.pacer = new RequestPacer(config.minIntervalMs);
  }

  isConfigured(): boolean {
    return Boolean(this.config.baseUrl);
  }

  async health(): Promise<ProviderResult<{ ok: true; latencyMs: number }>> {
    if (!this.isConfigured()) return this.notConfigured();
    const started = Date.now();
    try {
      await this.pacer.run(() =>
        httpJson<unknown>(`${this.config.baseUrl}/health`, {
          headers: this.authHeaders(),
          timeoutMs: 5_000,
          retries: 0,
        }),
      );
      return ok({ ok: true as const, latencyMs: Date.now() - started }, this.provenance());
    } catch (err) {
      return toProviderFailure(err, this.descriptor.id, this.descriptor.label);
    }
  }

  protected async search(req: SurfaceSearchRequest): Promise<ProviderResult<TransportOffer[]>> {
    if (!this.isConfigured()) return this.notConfigured();

    try {
      const raw = await this.pacer.run(() =>
        httpJson<unknown>(`${this.config.baseUrl}${this.path}`, {
          method: 'POST',
          headers: this.authHeaders(),
          timeoutMs: this.config.timeoutMs,
          ...(req.signal ? { signal: req.signal } : {}),
          body: {
            origin: {
              name: req.origin.name,
              countryCode: req.origin.countryCode,
              lat: req.origin.coordinates.lat,
              lon: req.origin.coordinates.lon,
            },
            destination: {
              name: req.destination.name,
              countryCode: req.destination.countryCode,
              lat: req.destination.coordinates.lat,
              lon: req.destination.coordinates.lon,
            },
            date: req.date,
            passengers: req.party,
            currency: req.currency,
            classCode: req.classCode,
            limit: req.limit,
          },
        }),
      );

      // The remote response is validated before anything downstream sees it.
      // A malformed provider must produce a provider error, not a malformed
      // itinerary that fails somewhere far from the cause.
      const parsed = RemoteResponse.safeParse(raw);
      if (!parsed.success) {
        return fail(
          'invalid_response',
          this.descriptor.id,
          this.descriptor.label,
          `${this.descriptor.label} returned a response that does not match the documented provider contract, so its results were discarded.`,
        );
      }

      const services = readItems(parsed.data.services, RemoteService);
      if (services.allInvalid) {
        return fail(
          'invalid_response',
          this.descriptor.id,
          this.descriptor.label,
          `${this.descriptor.label} returned services that do not match the documented provider contract, so all of them were discarded.`,
        );
      }

      if (parsed.data.services.length === 0) {
        return fail(
          'no_availability',
          this.descriptor.id,
          this.descriptor.label,
          `${this.descriptor.label} reports no services on ${req.date} for this route.`,
        );
      }

      const mode = this.descriptor.kinds[0] === 'rail' ? ('train' as const) : ('bus' as const);
      const offers = services.valid.map((s) =>
        toTransportOffer(s.data, mode, req.date, this.provenance(parsed.data.searchId ?? null, parsed.data.validUntil ?? null)),
      );
      return ok(offers, this.provenance(parsed.data.searchId ?? null), [
        ...parsed.data.warnings,
        ...droppedWarning(this.descriptor.label, services.dropped, 'service(s)'),
      ]);
    } catch (err) {
      return toProviderFailure(err, this.descriptor.id, this.descriptor.label);
    }
  }

  private authHeaders(): Record<string, string> {
    return this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {};
  }

  private notConfigured() {
    return fail(
      'not_configured',
      this.descriptor.id,
      this.descriptor.label,
      `${this.descriptor.label} is not configured. Set ${this.config.requiredEnv.join(' and ')} to an endpoint implementing the surface-transport provider contract (docs/providers.md). No timetable is shown for this mode until then.`,
    );
  }

  private provenance(searchId: string | null = null, validUntil: string | null = null): ProviderProvenance {
    return {
      provider: this.descriptor.id,
      providerLabel: this.descriptor.label,
      retrievedAt: new Date().toISOString(),
      validUntil,
      searchId,
      attribution: this.descriptor.attribution,
    };
  }
}

export class GenericRailProvider extends GenericSurfaceProvider implements RailProvider {
  constructor(config: GenericSurfaceConfig, id = 'rail') {
    super(id, 'rail', config, '/search/trains');
  }

  searchTrains(req: SurfaceSearchRequest): Promise<ProviderResult<TransportOffer[]>> {
    return this.search(req);
  }
}

export class GenericBusProvider extends GenericSurfaceProvider implements BusProvider {
  constructor(config: GenericSurfaceConfig, id = 'bus') {
    super(id, 'bus', config, '/search/buses');
  }

  searchBuses(req: SurfaceSearchRequest): Promise<ProviderResult<TransportOffer[]>> {
    return this.search(req);
  }
}

function toTransportOffer(
  s: z.infer<typeof RemoteService>,
  mode: 'train' | 'bus',
  date: string,
  provenance: ProviderProvenance,
): TransportOffer {
  const cheapest = [...s.fares].sort((a, b) => a.priceMajor - b.priceMajor)[0]!;
  const totalMinutes = s.legs.reduce((acc, l) => acc + l.durationMinutes, 0);
  const first = s.legs[0]!;
  const last = s.legs[s.legs.length - 1]!;

  return {
    // A service number repeats every day, so the day is part of the id.
    id: `${provenance.provider}:${date}:${s.id}`,
    mode,
    segments: s.legs.map((l) => ({
      mode,
      operatorCode: l.operatorCode ?? null,
      operatorName: l.operatorName ?? null,
      serviceNumber: l.serviceNumber ?? null,
      origin: {
        code: l.originCode ?? null,
        name: l.originName,
        coordinates: null,
        timezone: null,
        terminal: null,
      },
      destination: {
        code: l.destinationCode ?? null,
        name: l.destinationName,
        coordinates: null,
        timezone: null,
        terminal: null,
      },
      departureAt: l.departureAt,
      arrivalAt: l.arrivalAt,
      durationMinutes: l.durationMinutes,
      vehicleType: l.vehicleType ?? null,
    })),
    totalPrice: money(cheapest.priceMajor, s.currency),
    pricePerTraveler: money(cheapest.priceMajor, s.currency),
    itemisedFees: [],
    unpricedCosts: [],
    // Classes are passed through exactly as the operator names them. There is
    // no normalisation into invented "first/second class" tiers, because a
    // 3A berth and a semi-sleeper seat are not points on one shared scale.
    fareClasses: s.fares.map((f) => ({
      code: f.code,
      label: f.label,
      cabin: null,
      price: money(f.priceMajor, s.currency),
      availability: f.availability ?? null,
      availabilityLabel: f.availabilityLabel ?? null,
      refundable: f.refundable ?? null,
      checkedBagsIncluded: null,
      cabinBagKg: null,
    })),
    selectedFareCode: cheapest.code,
    totalDurationMinutes: totalMinutes,
    transfers: s.transfers,
    overnight: first.departureAt.slice(0, 10) !== last.arrivalAt.slice(0, 10),
    refundable: cheapest.refundable ?? null,
    cancellationPolicy: s.cancellationPolicy ?? null,
    baggageSummary: s.baggageSummary ?? null,
    revalidationToken: s.revalidationToken ?? null,
    provenance,
  };
}
