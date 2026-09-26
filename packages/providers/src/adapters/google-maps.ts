import {
  fail,
  ok,
  type ActivityOffer,
  type OpeningHours,
  type ProviderProvenance,
  type ProviderResult,
} from '@trip/shared';
import { httpJson, RequestPacer, toProviderFailure } from '../http.js';
import type {
  ActivityProvider,
  ActivitySearchRequest,
  ProviderDescriptor,
  RouteRequest,
  RouteResult,
  RoutingProvider,
} from '../types.js';

/**
 * Google Maps Platform adapter: Places (New) for things to do, Routes v2 for
 * transfer timing. Both are billed APIs, so the adapter asks for the narrowest
 * field mask that still answers the planner's questions and never fetches
 * fields it will not use.
 *
 * Opening hours are the reason this adapter exists. Without them the scheduler
 * has to treat every activity as always-open, which is how itineraries end up
 * sending people to a museum on the day it closes.
 */

const ACTIVITY_DESCRIPTOR: ProviderDescriptor = {
  id: 'google-places',
  label: 'Google Places',
  kinds: ['activity'],
  requiredEnv: ['GOOGLE_MAPS_API_KEY'],
  coverage: 'global',
  docsUrl: 'https://developers.google.com/maps/documentation/places/web-service/search-nearby',
  attribution: 'Places data © Google',
};

const ROUTING_DESCRIPTOR: ProviderDescriptor = {
  id: 'google-routes',
  label: 'Google Routes',
  kinds: ['routing'],
  requiredEnv: ['GOOGLE_MAPS_API_KEY'],
  coverage: 'global',
  docsUrl: 'https://developers.google.com/maps/documentation/routes',
  attribution: 'Routing data © Google',
};

export interface GoogleMapsConfig {
  apiKey: string;
  minIntervalMs: number;
}

interface GooglePlace {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  types?: string[];
  rating?: number;
  userRatingCount?: number;
  editorialSummary?: { text: string };
  regularOpeningHours?: {
    periods?: Array<{
      open?: { day: number; hour: number; minute: number };
      close?: { day: number; hour: number; minute: number };
    }>;
  };
  accessibilityOptions?: Record<string, boolean>;
}

export class GooglePlacesProvider implements ActivityProvider {
  readonly descriptor = ACTIVITY_DESCRIPTOR;
  private readonly pacer: RequestPacer;

  constructor(private readonly config: GoogleMapsConfig) {
    this.pacer = new RequestPacer(config.minIntervalMs);
  }

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async health(): Promise<ProviderResult<{ ok: true; latencyMs: number }>> {
    if (!this.isConfigured()) return this.notConfigured();
    const started = Date.now();
    const res = await this.searchActivities({
      destination: { countryCode: 'FR' } as never,
      near: { lat: 48.8584, lon: 2.2945 },
      radiusKm: 2,
      categories: [],
      accessibilityNeeds: [],
      currency: 'EUR',
      limit: 1,
    });
    if (res.status !== 'ok') return res;
    return ok({ ok: true as const, latencyMs: Date.now() - started }, res.provenance);
  }

  async searchActivities(req: ActivitySearchRequest): Promise<ProviderResult<ActivityOffer[]>> {
    if (!this.isConfigured()) return this.notConfigured();

    const includedTypes = req.categories.length ? req.categories : DEFAULT_ACTIVITY_TYPES;
    try {
      const res = await this.pacer.run(() =>
        httpJson<{ places?: GooglePlace[] }>('https://places.googleapis.com/v1/places:searchNearby', {
          method: 'POST',
          headers: {
            'X-Goog-Api-Key': this.config.apiKey,
            'X-Goog-FieldMask': [
              'places.id',
              'places.displayName',
              'places.formattedAddress',
              'places.location',
              'places.types',
              'places.rating',
              'places.userRatingCount',
              'places.editorialSummary',
              'places.regularOpeningHours',
              'places.accessibilityOptions',
            ].join(','),
          },
          body: {
            includedTypes,
            maxResultCount: Math.min(20, req.limit),
            locationRestriction: {
              circle: {
                center: { latitude: req.near.lat, longitude: req.near.lon },
                radius: Math.min(50_000, req.radiusKm * 1000),
              },
            },
            rankPreference: 'POPULARITY',
          },
          timeoutMs: 15_000,
        }),
      );

      const places = res.places ?? [];
      const warnings: string[] = [];
      const offers = places
        .map((p) => this.toActivity(p, warnings))
        .filter((a): a is ActivityOffer => a !== null);

      const filtered = req.accessibilityNeeds.length
        ? offers.filter((a) => matchesAccessibility(a, req.accessibilityNeeds))
        : offers;

      if (req.accessibilityNeeds.length && filtered.length < offers.length) {
        warnings.push(
          `${offers.length - filtered.length} place(s) were excluded because Google does not report the accessibility features this party needs. Absence of data is not proof of inaccessibility; confirm directly with the venue.`,
        );
      }

      if (filtered.length === 0) {
        return fail(
          'no_availability',
          ACTIVITY_DESCRIPTOR.id,
          ACTIVITY_DESCRIPTOR.label,
          'No matching places were found in this area.',
        );
      }
      return ok(filtered, provenanceFor(ACTIVITY_DESCRIPTOR), warnings);
    } catch (err) {
      return toProviderFailure(err, ACTIVITY_DESCRIPTOR.id, ACTIVITY_DESCRIPTOR.label);
    }
  }

  private toActivity(p: GooglePlace, warnings: string[]): ActivityOffer | null {
    if (!p.location) return null;
    const hours = toOpeningHours(p);
    if (hours === null) {
      warnings.push(
        `Opening hours are not published for ${p.displayName?.text ?? p.id}; the itinerary flags it for checking rather than assuming it is open.`,
      );
    }
    return {
      id: `google:${p.id}`,
      name: p.displayName?.text ?? 'Unnamed place',
      category: p.types?.[0] ?? null,
      description: p.editorialSummary?.text ?? null,
      coordinates: { lat: p.location.latitude, lon: p.location.longitude },
      address: p.formattedAddress ?? null,
      openingHours: hours,
      // Google does not publish a visit duration, so the scheduler applies a
      // category default and marks it as an assumption.
      typicalDurationMinutes: null,
      price: null,
      priceIsEstimate: false,
      bookingRequired: null,
      rating: p.rating ?? null,
      ratingCount: p.userRatingCount ?? null,
      accessibility: Object.entries(p.accessibilityOptions ?? {})
        .filter(([, v]) => v === true)
        .map(([k]) => k),
      provenance: provenanceFor(ACTIVITY_DESCRIPTOR),
    };
  }

  private notConfigured() {
    return fail(
      'not_configured',
      ACTIVITY_DESCRIPTOR.id,
      ACTIVITY_DESCRIPTOR.label,
      'Google Places is not configured. Set GOOGLE_MAPS_API_KEY to include things to do with real opening hours.',
    );
  }
}

export class GoogleRoutesProvider implements RoutingProvider {
  readonly descriptor = ROUTING_DESCRIPTOR;
  private readonly pacer: RequestPacer;

  constructor(private readonly config: GoogleMapsConfig) {
    this.pacer = new RequestPacer(config.minIntervalMs);
  }

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async health(): Promise<ProviderResult<{ ok: true; latencyMs: number }>> {
    if (!this.isConfigured()) {
      return fail('not_configured', ROUTING_DESCRIPTOR.id, ROUTING_DESCRIPTOR.label, 'Set GOOGLE_MAPS_API_KEY.');
    }
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
      return fail('not_configured', ROUTING_DESCRIPTOR.id, ROUTING_DESCRIPTOR.label, 'Set GOOGLE_MAPS_API_KEY.');
    }
    const travelMode = { driving: 'DRIVE', walking: 'WALK', cycling: 'BICYCLE' }[req.profile];
    try {
      const res = await this.pacer.run(() =>
        httpJson<{ routes?: Array<{ distanceMeters?: number; duration?: string; polyline?: { encodedPolyline?: string } }> }>(
          'https://routes.googleapis.com/directions/v2:computeRoutes',
          {
            method: 'POST',
            headers: {
              'X-Goog-Api-Key': this.config.apiKey,
              'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
            },
            body: {
              origin: { location: { latLng: { latitude: req.from.lat, longitude: req.from.lon } } },
              destination: { location: { latLng: { latitude: req.to.lat, longitude: req.to.lon } } },
              travelMode,
              // Live traffic matters for airport transfers, where a bad guess
              // is the difference between making and missing a flight.
              ...(travelMode === 'DRIVE'
                ? { routingPreference: 'TRAFFIC_AWARE', departureTime: req.departAt }
                : {}),
            },
            timeoutMs: 15_000,
          },
        ),
      );
      const route = res.routes?.[0];
      if (!route?.distanceMeters || !route.duration) {
        return fail(
          'unsupported_route',
          ROUTING_DESCRIPTOR.id,
          ROUTING_DESCRIPTOR.label,
          'Google could not find a route between these points.',
        );
      }
      return ok(
        {
          distanceKm: Number((route.distanceMeters / 1000).toFixed(2)),
          durationMinutes: Math.round(Number(route.duration.replace('s', '')) / 60),
          geometry: route.polyline?.encodedPolyline ?? null,
        },
        provenanceFor(ROUTING_DESCRIPTOR),
      );
    } catch (err) {
      return toProviderFailure(err, ROUTING_DESCRIPTOR.id, ROUTING_DESCRIPTOR.label);
    }
  }
}

const DEFAULT_ACTIVITY_TYPES = [
  'tourist_attraction',
  'museum',
  'art_gallery',
  'historical_landmark',
  'park',
];

/** Google reports hours as day/hour/minute periods; null means unpublished. */
function toOpeningHours(p: GooglePlace): OpeningHours[] | null {
  const periods = p.regularOpeningHours?.periods;
  if (!periods || periods.length === 0) return null;
  const out: OpeningHours[] = [];
  for (const period of periods) {
    if (!period.open) continue;
    const opens = `${pad(period.open.hour)}:${pad(period.open.minute)}`;
    const closes = period.close
      ? `${pad(period.close.hour)}:${pad(period.close.minute)}`
      : '23:59';
    out.push({ weekday: period.open.day, opens, closes });
  }
  return out.length ? out : null;
}

/**
 * The Google accessibility option that confirms each need, where Google
 * publishes one. A wheelchair-accessible car park does not make the entrance
 * step-free, so each need is matched only to its own field. Needs Google has
 * no field for (service animals, visual or hearing support) cannot be
 * checked here; the planner's validator says so on the plan.
 */
const PLACE_EVIDENCE: Record<string, string> = {
  step_free_access: 'wheelchairAccessibleEntrance',
  wheelchair_accessible_room: 'wheelchairAccessibleEntrance',
  accessible_bathroom: 'wheelchairAccessibleRestroom',
};

export function matchesAccessibility(a: Pick<ActivityOffer, 'accessibility'>, needs: string[]): boolean {
  return needs.every((need) => {
    const field = PLACE_EVIDENCE[need];
    return field === undefined || a.accessibility.includes(field);
  });
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function provenanceFor(d: ProviderDescriptor): ProviderProvenance {
  return {
    provider: d.id,
    providerLabel: d.label,
    retrievedAt: new Date().toISOString(),
    validUntil: null,
    searchId: null,
    attribution: d.attribution,
  };
}
