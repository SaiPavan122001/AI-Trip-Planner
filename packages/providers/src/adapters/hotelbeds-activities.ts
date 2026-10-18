import { fail, money, ok, type ActivityOffer, type Money, type ProviderProvenance, type ProviderResult } from '@trip/shared';
import { InvalidResponseError, toProviderFailure } from '../http.js';
import { droppedWarning, readItems, readResponse } from '../guard.js';
import { HotelbedsActivitiesResponse, HotelbedsActivity } from '../schemas.js';
import type { ActivityProvider, ActivitySearchRequest, PartySize, ProviderDescriptor } from '../types.js';
import type { HotelbedsClient } from './hotelbeds-client.js';

/**
 * Hotelbeds Activities API: bookable tours and tickets. Its own capability,
 * with its own credentials and switch; it does not depend on, and is not
 * switched on by, the Hotel or Transfers API.
 *
 * Availability is `POST /activity-api/3.0/activities/availability` with a date
 * range, the travellers' ages and one filter (here the destination's position,
 * the documented `gps` filter). It returns real, bookable products with prices.
 *
 * What it does not say, and so what this adapter does not claim:
 *  - Where each activity is. The availability answer carries no coordinates, so
 *    every activity is placed at the searched point (the destination centre) and
 *    says so; it is not a meeting point.
 *  - Opening hours or a start time: left unknown, so the scheduler flags them.
 *  - Availability on one particular day. The price is Hotelbeds' for the trip's
 *    date range and is marked as not yet confirmed for a day; the day-specific
 *    check (the Details/CheckRate operation) is not implemented.
 *
 * Read only: it never confirms a booking.
 */

const DESCRIPTOR = (env: string): ProviderDescriptor => ({
  id: 'hotelbeds-activities',
  label: env === 'live' ? 'Hotelbeds Activities' : 'Hotelbeds Activities (test account)',
  kinds: ['activity'],
  requiredEnv: ['HOTELBEDS_API_KEY', 'HOTELBEDS_SECRET'],
  coverage: 'global',
  docsUrl: 'https://developer.hotelbeds.com/documentation/activities/',
  attribution: 'Activity content and rates provided by Hotelbeds',
});

/** Ages sent for travellers whose age this planner does not hold. They only choose which price band is quoted. */
const ADULT_AGE = 30;
const CHILD_AGE = 8;
const INFANT_AGE = 1;

export class HotelbedsActivitiesProvider implements ActivityProvider {
  readonly descriptor: ProviderDescriptor;

  constructor(private readonly client: HotelbedsClient) {
    this.descriptor = DESCRIPTOR(client.environment);
  }

  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  /** The Activities API has no status call; a one-result availability search is the cheapest authenticated read, and needs dates, so health only checks the credentials are present. */
  async health(): Promise<ProviderResult<{ ok: true; latencyMs: number }>> {
    if (!this.isConfigured()) return this.notConfigured();
    return ok({ ok: true as const, latencyMs: 0 }, this.provenance());
  }

  async searchActivities(req: ActivitySearchRequest): Promise<ProviderResult<ActivityOffer[]>> {
    if (!this.isConfigured()) return this.notConfigured();
    if (!req.window) {
      return fail(
        'invalid_request',
        this.descriptor.id,
        this.descriptor.label,
        'Bookable activities are searched for dates and a party, and this search did not supply them.',
      );
    }
    const { from, to, party } = req.window;

    try {
      const raw = await this.client.post<unknown>(
        '/activity-api/3.0/activities/availability',
        {
          filters: [
            {
              searchFilterItems: [
                { type: 'gps', latitude: req.near.lat, longitude: req.near.lon },
              ],
            },
          ],
          from,
          to,
          language: 'en',
          paxes: paxes(party),
          pagination: { itemsPerPage: Math.min(100, Math.max(1, req.limit * 3)), page: 1 },
          order: 'DEFAULT',
        },
        req.signal,
      );

      const res = readResponse(HotelbedsActivitiesResponse, raw, 'activity availability');
      const list = res.activities ?? [];
      const items = readItems(list, HotelbedsActivity);
      if (items.allInvalid) throw new InvalidResponseError('activity availability', 'no activity had the documented shape');

      const offers: ActivityOffer[] = [];
      for (const { data } of items.valid) {
        const offer = this.toOffer(data, req, party);
        if (offer) offers.push(offer);
      }
      if (offers.length === 0) {
        return fail(
          'no_availability',
          this.descriptor.id,
          this.descriptor.label,
          `No bookable activities were returned for ${from} to ${to} near ${req.destination.name}.`,
        );
      }

      const warnings = droppedWarning(this.descriptor.label, items.dropped, 'activity listing(s)');
      warnings.push(
        'Activity prices are Hotelbeds prices for your travel dates and are not yet confirmed for a particular day; locations are the destination centre, not a meeting point.',
      );
      if (party.children + party.infants > 0) {
        warnings.push('Child ages are not collected, so children were searched as age 8 and infants as age 1; prices may differ.');
      }
      if (this.client.environment !== 'live') {
        warnings.push('These activities come from the Hotelbeds test account and are not live inventory.');
      }
      return ok(offers.slice(0, req.limit), this.provenance(`${from}-${to}`), warnings);
    } catch (err) {
      return toProviderFailure(err, this.descriptor.id, this.descriptor.label);
    }
  }

  private toOffer(a: HotelbedsActivity, req: ActivitySearchRequest, party: PartySize): ActivityOffer | null {
    const code = a.activityCode ?? a.content?.activityCode ?? a.content?.code;
    const name = a.content?.name;
    const currency = a.currencyName ?? a.content?.currency;
    if (!code || !name || !currency || currency.length !== 3) return null;

    // The cheapest priced option for this party across the activity's modalities.
    const totals: number[] = [];
    let duration: number | null = null;
    for (const m of a.modalities ?? []) {
      for (const rate of m.rates ?? []) {
        for (const d of rate.rateDetails ?? []) {
          if (d.totalAmount) totals.push(Number(d.totalAmount.amount));
        }
      }
      duration ??= minutes(m.duration);
    }
    let price: Money | null = null;
    if (totals.length > 0) {
      price = money(Math.min(...totals), currency);
    } else {
      // No rate detail: a total is only built when every traveller type has a stated price.
      const from = a.amountsFrom ?? [];
      const adult = from.find((x) => x.paxType === 'ADULT')?.amount;
      const child = from.find((x) => x.paxType === 'CHILD')?.amount;
      const kids = party.children + party.infants;
      if (adult != null && (kids === 0 || child != null)) {
        price = money(Number(adult) * party.adults + (kids > 0 ? Number(child) * kids : 0), currency);
      }
    }

    return {
      id: `hotelbeds-activity:${code}`,
      name,
      category: 'bookable_activity',
      description: 'Bookable with Hotelbeds. The provider does not state a meeting point, so the location shown is the destination centre.',
      coordinates: req.near,
      address: null,
      openingHours: null,
      typicalDurationMinutes: duration,
      price,
      // A provider price for the date range, not yet confirmed for one day.
      priceIsEstimate: price !== null,
      bookingRequired: true,
      rating: null,
      ratingCount: null,
      accessibility: [],
      provenance: this.provenance(code),
    };
  }

  private notConfigured() {
    return fail(
      'not_configured',
      this.descriptor.id,
      this.descriptor.label,
      'Hotelbeds Activities is not configured. Set HOTELBEDS_API_KEY and HOTELBEDS_SECRET (or the HOTELBEDS_ACTIVITIES_* pair) to search bookable activities.',
    );
  }

  private provenance(searchId: string | null = null): ProviderProvenance {
    return {
      provider: this.descriptor.id,
      providerLabel: this.descriptor.label,
      retrievedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 20 * 60_000).toISOString(),
      searchId,
      attribution: this.descriptor.attribution,
    };
  }
}

function paxes(party: PartySize): Array<{ age: number }> {
  return [
    ...Array.from({ length: party.adults }, () => ({ age: ADULT_AGE })),
    ...Array.from({ length: party.children }, () => ({ age: CHILD_AGE })),
    ...Array.from({ length: party.infants }, () => ({ age: INFANT_AGE })),
  ];
}

/**
 * A duration in minutes, only when its unit is stated. A bare number has no
 * documented unit, so it is not guessed.
 */
function minutes(d: unknown): number | null {
  if (d == null || typeof d !== 'object') return null;
  const value = Number((d as { value?: unknown }).value);
  const metric = String((d as { metric?: unknown }).metric ?? '').toLowerCase();
  if (!Number.isFinite(value) || value <= 0) return null;
  if (metric.startsWith('min')) return Math.round(value);
  if (metric.startsWith('hour')) return Math.round(value * 60);
  if (metric.startsWith('day')) return Math.round(value * 1440);
  return null;
}
