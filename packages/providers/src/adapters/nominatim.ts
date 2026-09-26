import tzLookup from 'tz-lookup';
import { fail, ok, type Coordinates, type Place, type ProviderResult } from '@trip/shared';
import { InvalidResponseError, httpJson, RequestPacer, toProviderFailure } from '../http.js';
import { droppedWarning, readItems, readResponse } from '../guard.js';
import { NominatimRow, NominatimSearchResponse } from '../schemas.js';
import type { GeocodingProvider, ProviderDescriptor } from '../types.js';

/**
 * OpenStreetMap Nominatim geocoder. Needs no credentials, which makes it the
 * default place resolver so a fresh clone can classify a journey without any
 * signup. Its usage policy caps traffic at one request per second and requires
 * an identifying User-Agent, both of which are enforced here rather than left
 * to the operator to remember.
 */

const DESCRIPTOR: ProviderDescriptor = {
  id: 'nominatim',
  label: 'OpenStreetMap Nominatim',
  kinds: ['geocoding'],
  requiredEnv: ['NOMINATIM_USER_AGENT'],
  coverage: 'global',
  docsUrl: 'https://nominatim.org/release-docs/latest/api/Search/',
  attribution: 'Geocoding © OpenStreetMap contributors (ODbL)',
};

export interface NominatimConfig {
  baseUrl: string;
  /** Required by the usage policy: a contact address for the deployment. */
  userAgent: string;
  /** Public Nominatim allows 1 req/s. Self-hosted instances can go faster. */
  minIntervalMs: number;
}

export class NominatimProvider implements GeocodingProvider {
  readonly descriptor = DESCRIPTOR;
  private readonly pacer: RequestPacer;

  constructor(private readonly config: NominatimConfig) {
    this.pacer = new RequestPacer(config.minIntervalMs);
  }

  isConfigured(): boolean {
    return Boolean(this.config.userAgent && this.config.baseUrl);
  }

  async health(): Promise<ProviderResult<{ ok: true; latencyMs: number }>> {
    const started = Date.now();
    const res = await this.resolvePlace('Paris', { limit: 1 });
    if (res.status !== 'ok') return res;
    return ok({ ok: true as const, latencyMs: Date.now() - started }, res.provenance);
  }

  async resolvePlace(query: string, opts: { limit?: number } = {}): Promise<ProviderResult<Place[]>> {
    if (!this.isConfigured()) {
      return fail(
        'not_configured',
        DESCRIPTOR.id,
        DESCRIPTOR.label,
        'Set NOMINATIM_USER_AGENT to a contact address before using the OpenStreetMap geocoder.',
      );
    }
    try {
      const raw = await this.pacer.run(() =>
        httpJson<unknown>(`${this.config.baseUrl}/search`, {
          query: {
            q: query,
            format: 'jsonv2',
            addressdetails: 1,
            limit: opts.limit ?? 5,
            'accept-language': 'en',
          },
          headers: { 'User-Agent': this.config.userAgent },
        }),
      );
      const listed = readItems(readResponse(NominatimSearchResponse, raw, 'place search'), NominatimRow);
      if (listed.allInvalid) throw new InvalidResponseError('place search', 'no result had the documented shape');
      const rows = listed.valid.map((v) => v.data);
      const places = rows.map((r) => this.toPlace(r)).filter((p): p is Place => p !== null);
      if (places.length === 0) {
        return fail(
          'no_availability',
          DESCRIPTOR.id,
          DESCRIPTOR.label,
          `No place matching "${query}" could be resolved. Try adding a country, for example "Hyderabad, India".`,
        );
      }
      return ok(places, this.provenance(), [
        ...this.dropWarnings(rows.length, places.length),
        ...droppedWarning(DESCRIPTOR.label, listed.dropped, 'result(s)'),
      ]);
    } catch (err) {
      return toProviderFailure(err, DESCRIPTOR.id, DESCRIPTOR.label);
    }
  }

  async reverse(coords: Coordinates): Promise<ProviderResult<Place>> {
    if (!this.isConfigured()) {
      return fail('not_configured', DESCRIPTOR.id, DESCRIPTOR.label, 'Nominatim is not configured.');
    }
    try {
      const raw = await this.pacer.run(() =>
        httpJson<unknown>(`${this.config.baseUrl}/reverse`, {
          query: { lat: coords.lat, lon: coords.lon, format: 'jsonv2', addressdetails: 1 },
          headers: { 'User-Agent': this.config.userAgent },
        }),
      );
      // Nominatim answers 200 with {"error": ...} when a point has nothing at it.
      const empty = typeof raw === 'object' && raw !== null && 'error' in raw;
      const place = empty ? null : this.toPlace(readResponse(NominatimRow, raw, 'reverse lookup'));
      if (!place) {
        return fail(
          'no_availability',
          DESCRIPTOR.id,
          DESCRIPTOR.label,
          'Those coordinates could not be resolved to a place with a country.',
        );
      }
      return ok(place, this.provenance());
    } catch (err) {
      return toProviderFailure(err, DESCRIPTOR.id, DESCRIPTOR.label);
    }
  }

  /**
   * A row without a country code is discarded rather than patched up: journey
   * classification depends on the country, and guessing it would silently
   * decide whether the trip is domestic or international.
   */
  private toPlace(row: NominatimRow): Place | null {
    const countryCode = row.address?.['country_code']?.toUpperCase();
    if (!countryCode || countryCode.length !== 2) return null;
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    let timezone: string;
    try {
      timezone = tzLookup(lat, lon);
    } catch {
      return null;
    }

    const addr = row.address ?? {};
    const city =
      addr['city'] ?? addr['town'] ?? addr['village'] ?? addr['municipality'] ?? row.name ?? '';
    return {
      id: `nominatim:${row.place_id}`,
      name: city || row.display_name.split(',')[0]!.trim(),
      displayName: row.display_name,
      coordinates: { lat, lon },
      countryCode,
      countryName: addr['country'] ?? countryCode,
      ...(addr['state'] ? { region: addr['state'] } : {}),
      timezone,
      airports: [],
      source: DESCRIPTOR.id,
      resolvedAt: new Date().toISOString(),
    };
  }

  private dropWarnings(received: number, kept: number): string[] {
    if (received === kept) return [];
    return [
      `${received - kept} result(s) from OpenStreetMap were discarded because they had no resolvable country or timezone.`,
    ];
  }

  private provenance() {
    return {
      provider: DESCRIPTOR.id,
      providerLabel: DESCRIPTOR.label,
      retrievedAt: new Date().toISOString(),
      validUntil: null,
      searchId: null,
      attribution: DESCRIPTOR.attribution,
    };
  }
}
