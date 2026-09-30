import { add, type Money, type TransportOffer } from '@trip/shared';

/**
 * What choosing a transport option is known to cost: the fare plus every cost
 * charged on top of it that can be priced, including estimates such as fuel
 * for a drive. This is the figure every comparison uses, so a drive is not
 * "free" when its fuel can be estimated, and a fare with a separate baggage
 * charge is not cheaper than it is.
 *
 * Costs nobody can price (`unpricedCosts`, e.g. tolls) are not in it and are
 * never treated as zero; they are shown as "not calculated" instead. For
 * driving your own car with no vehicle profile configured, the known cost is
 * the real ₹0 fare, which is exactly what the traveller pays a provider.
 */
export function knownTransportCost(offer: TransportOffer): Money {
  const extras = offer.itemisedFees.filter((f) => !f.included).map((f) => f.amount);
  return add(offer.totalPrice, ...extras);
}
