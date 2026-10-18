import { fail, localParts, money, ok, type ProviderProvenance, type ProviderResult } from '@trip/shared';
import { InvalidResponseError, toProviderFailure } from '../http.js';
import { droppedWarning, readItems, readResponse } from '../guard.js';
import { HotelbedsTransferService, HotelbedsTransfersResponse } from '../schemas.js';
import type {
  ProviderDescriptor,
  QuotedTransfer,
  QuotedTransferProvider,
  QuotedTransferRequest,
  TransferLocation,
} from '../types.js';
import type { HotelbedsClient } from './hotelbeds-client.js';

/**
 * Hotelbeds Transfers API: priced, bookable transfers between places it knows
 * by code, in practice an airport (IATA) and a hotel (ATLAS). Its own
 * capability, with its own credentials and switch. It is NOT a taxi-on-demand
 * search and does not replace routing: an unsupported pair simply returns no
 * quote, and the planner then shows its routing-based estimate, labelled as one.
 *
 * `GET /transfer-api/1.0/availability/{language}/from/{fromType}/{fromCode}/to/{toType}/{toCode}/{outbound}/{adults}/{children}/{infants}`
 * (one way: no `inbound`). The documentation defines adults as ages 12-99,
 * children 3-11 and infants 0-2. Read only: nothing is booked.
 *
 * The availability answer carries a `rateKey` per service; the documented flow
 * has no separate re-price call at this stage, so the key is handed on as the
 * service's token and no revalidation is claimed.
 */

const DESCRIPTOR = (env: string): ProviderDescriptor => ({
  id: 'hotelbeds-transfers',
  label: env === 'live' ? 'Hotelbeds Transfers' : 'Hotelbeds Transfers (test account)',
  kinds: ['transfer_quote'],
  requiredEnv: ['HOTELBEDS_API_KEY', 'HOTELBEDS_SECRET'],
  coverage: 'global',
  docsUrl: 'https://developer.hotelbeds.com/documentation/transfers/',
  attribution: 'Transfer content and rates provided by Hotelbeds',
});

const CODE = /^[A-Za-z0-9_-]{1,20}$/;

export class HotelbedsTransfersProvider implements QuotedTransferProvider {
  readonly descriptor: ProviderDescriptor;

  constructor(private readonly client: HotelbedsClient) {
    this.descriptor = DESCRIPTOR(client.environment);
  }

  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  /** There is no status call for Transfers; only the presence of credentials is checked. */
  async health(): Promise<ProviderResult<{ ok: true; latencyMs: number }>> {
    if (!this.isConfigured()) return this.notConfigured();
    return ok({ ok: true as const, latencyMs: 0 }, this.provenance());
  }

  async quoteTransfers(req: QuotedTransferRequest): Promise<ProviderResult<QuotedTransfer[]>> {
    if (!this.isConfigured()) return this.notConfigured();
    if (!validLocation(req.from) || !validLocation(req.to)) {
      return fail('invalid_request', this.descriptor.id, this.descriptor.label, 'A transfer needs an airport code and a hotel code, and one of them was not usable.');
    }
    const adults = req.party.adults;
    const children = req.party.children;
    const infants = req.party.infants;
    if (adults < 1) {
      return fail('invalid_request', this.descriptor.id, this.descriptor.label, 'A transfer needs at least one adult.');
    }

    // The provider wants the local clock time at the pick-up point.
    const local = localParts(req.at, req.timezone);
    const outbound = `${local.date}T${local.time}:00`;
    const path =
      `/transfer-api/1.0/availability/en/from/${req.from.type}/${encodeURIComponent(req.from.code)}` +
      `/to/${req.to.type}/${encodeURIComponent(req.to.code)}/${outbound}/${adults}/${children}/${infants}`;

    try {
      const raw = await this.client.get<unknown>(path, {}, req.signal);
      const res = readResponse(HotelbedsTransfersResponse, raw, 'transfer availability');
      const items = readItems(res.services ?? [], HotelbedsTransferService);
      if (items.allInvalid) throw new InvalidResponseError('transfer availability', 'no service had the documented shape');

      const quotes: QuotedTransfer[] = items.valid.map(({ data: s }) => ({
        id: `hotelbeds-transfer:${String(s.id)}`,
        kind: s.transferType === 'SHARED' ? 'shared' : 'private',
        vehicle: s.vehicle?.name ?? null,
        category: s.category?.name ?? null,
        minPassengers: s.minPaxCapacity ?? null,
        maxPassengers: s.maxPaxCapacity ?? null,
        luggage: luggageOf(s),
        price: money(Number(s.price.totalAmount), s.price.currencyId),
        cancellationPolicy: cancellationOf(s),
        token: s.rateKey,
      }));
      if (quotes.length === 0) {
        return fail(
          'no_availability',
          this.descriptor.id,
          this.descriptor.label,
          `No transfers are offered between ${req.from.code} and ${req.to.code} at that time.`,
        );
      }
      const warnings = droppedWarning(this.descriptor.label, items.dropped, 'transfer service(s)');
      if (this.client.environment !== 'live') {
        warnings.push('These transfers come from the Hotelbeds test account and are not live inventory.');
      }
      return ok(quotes, this.provenance(`${req.from.code}-${req.to.code}`), warnings);
    } catch (err) {
      return toProviderFailure(err, this.descriptor.id, this.descriptor.label);
    }
  }

  private notConfigured() {
    return fail(
      'not_configured',
      this.descriptor.id,
      this.descriptor.label,
      'Hotelbeds Transfers is not configured. Set HOTELBEDS_API_KEY and HOTELBEDS_SECRET (or the HOTELBEDS_TRANSFERS_* pair) to quote airport transfers.',
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

function validLocation(l: TransferLocation): boolean {
  return (l.type === 'IATA' || l.type === 'ATLAS') && CODE.test(l.code);
}

/** Luggage as the provider states it, if it states any: never inferred from the vehicle. */
function luggageOf(s: HotelbedsTransferService): string | null {
  const info = s.content?.transferDetailInfo ?? [];
  const bag = info.find((i) => /bag|luggage|suitcase/i.test(`${i.name ?? ''} ${i.type ?? ''}`));
  if (!bag) return null;
  const text = bag.description ?? (bag.value != null ? `${bag.value}${bag.metric ? ` ${bag.metric}` : ''}` : null);
  return text ? `${bag.name ?? 'Luggage'}: ${text}` : null;
}

function cancellationOf(s: HotelbedsTransferService): string | null {
  const policies = s.cancellationPolicies ?? [];
  if (policies.length === 0) return null;
  return policies
    .filter((p) => p.from)
    .map((p) => `From ${p.from}: ${p.amount ?? '?'} ${p.currencyId ?? s.price.currencyId} is charged`)
    .join('; ');
}
