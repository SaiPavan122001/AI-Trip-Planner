import {
  SUPPORTED_CURRENCY,
  type HotelOffer,
  type Money,
  type ProviderNote,
  type ProviderProvenance,
  type TransportOffer,
} from '@trip/shared';

/**
 * The currency boundary. Every provider result passes through here before
 * the planner compares, filters or totals anything, so the rest of the engine
 * only ever sees rupees.
 *
 * A price in another currency is never converted, because there is no
 * exchange-rate source and inventing a rate would present a guess as a
 * quote. Nor is it quietly kept: comparing it with rupees would either crash
 * or, worse, let it slip past a budget check. It is set aside, and the
 * traveller is told which provider returned what.
 */

function foreignCurrencies(amounts: Money[]): string[] {
  return [...new Set(amounts.map((m) => m.currency).filter((c) => c !== SUPPORTED_CURRENCY))];
}

function note(provenance: ProviderProvenance, currencies: string[], what: string): ProviderNote {
  return {
    provider: provenance.provider,
    providerLabel: provenance.providerLabel,
    status: 'unsupported_capability',
    message: `${provenance.providerLabel} returned ${what} priced in ${currencies.join(', ')}. This planner works in Indian rupees only and does not convert currencies, so ${what === 'a price' ? 'that price is shown as unknown' : 'they were not used'}.`,
    occurredAt: new Date().toISOString(),
  };
}

/** Every amount an offer carries, so a single foreign fee is not missed. */
function transportAmounts(offer: TransportOffer): Money[] {
  return [
    offer.totalPrice,
    offer.pricePerTraveler,
    ...offer.itemisedFees.map((f) => f.amount),
    ...offer.fareClasses.map((f) => f.price),
  ];
}

export function keepSupportedTransport(offers: TransportOffer[]): {
  kept: TransportOffer[];
  notes: ProviderNote[];
} {
  const kept: TransportOffer[] = [];
  const dropped = new Map<string, { provenance: ProviderProvenance; currencies: Set<string> }>();
  for (const offer of offers) {
    const foreign = foreignCurrencies(transportAmounts(offer));
    if (foreign.length === 0) {
      kept.push(offer);
      continue;
    }
    const entry = dropped.get(offer.provenance.provider) ?? {
      provenance: offer.provenance,
      currencies: new Set<string>(),
    };
    foreign.forEach((c) => entry.currencies.add(c));
    dropped.set(offer.provenance.provider, entry);
  }
  return {
    kept,
    notes: [...dropped.values()].map((d) => note(d.provenance, [...d.currencies], 'options')),
  };
}

/**
 * Keeps only the rates quoted in rupees; a property with none left is set
 * aside entirely, because it has no price the planner can use.
 */
export function keepSupportedHotels(hotels: HotelOffer[]): { kept: HotelOffer[]; notes: ProviderNote[] } {
  const kept: HotelOffer[] = [];
  const dropped = new Map<string, { provenance: ProviderProvenance; currencies: Set<string> }>();
  for (const hotel of hotels) {
    const rooms = hotel.rooms.filter(
      (r) => foreignCurrencies([r.totalPrice, r.pricePerNight]).length === 0,
    );
    if (rooms.length < hotel.rooms.length) {
      const entry = dropped.get(hotel.provenance.provider) ?? {
        provenance: hotel.provenance,
        currencies: new Set<string>(),
      };
      hotel.rooms
        .flatMap((r) => foreignCurrencies([r.totalPrice, r.pricePerNight]))
        .forEach((c) => entry.currencies.add(c));
      dropped.set(hotel.provenance.provider, entry);
    }
    if (rooms.length > 0) kept.push({ ...hotel, rooms });
  }
  return {
    kept,
    notes: [...dropped.values()].map((d) => note(d.provenance, [...d.currencies], 'rates')),
  };
}

/**
 * For a component that stays useful without a price (a transfer's route and
 * time, a place to visit): a foreign price becomes unknown rather than zero,
 * and the traveller is told why.
 */
export function supportedPriceOrUnknown(
  price: Money | null,
  provenance: ProviderProvenance,
): { price: Money | null; note: ProviderNote | null } {
  if (price === null || price.currency === SUPPORTED_CURRENCY) return { price, note: null };
  return { price: null, note: note(provenance, [price.currency], 'a price') };
}
