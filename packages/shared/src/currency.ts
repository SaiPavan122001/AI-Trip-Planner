/**
 * Currency facts with no dependencies, so the browser can import them from
 * `@trip/shared/currency` without pulling in the schema library that the rest
 * of this package needs. `money.ts` re-exports everything here.
 */

/**
 * The only currency this product plans in. It serves travellers in India, so
 * every budget, quote and total is in Indian rupees.
 *
 * There is deliberately no currency conversion. A provider price in any other
 * currency is not converted at an invented rate: it is set aside with a
 * visible reason. Supporting other currencies needs a real exchange-rate
 * source, and that is future work, not something to approximate here.
 */
export const SUPPORTED_CURRENCY = 'INR' as const;

/** Currencies whose minor unit is not 1/100. Extend as providers require. */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XAF', 'XOF']);
const THREE_DECIMAL = new Set(['BHD', 'KWD', 'OMR', 'TND', 'JOD', 'IQD']);

export function minorUnitExponent(currency: string): number {
  if (ZERO_DECIMAL.has(currency)) return 0;
  if (THREE_DECIMAL.has(currency)) return 3;
  return 2;
}
