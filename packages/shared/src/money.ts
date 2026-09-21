import { z } from 'zod';

/**
 * Money is always stored as an integer in the currency's minor unit
 * (paise for INR, cents for USD/EUR). Floating point money is a bug source
 * and, in a planner that repeatedly sums dozens of components, the drift
 * becomes user-visible.
 */
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, 'ISO-4217 currency code');
export type CurrencyCode = z.infer<typeof CurrencyCode>;

export const Money = z.object({
  /** Integer amount in the currency's minor unit. */
  amount: z.number().int(),
  currency: CurrencyCode,
});
export type Money = z.infer<typeof Money>;

/** Currencies whose minor unit is not 1/100. Extend as providers require. */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XAF', 'XOF']);
const THREE_DECIMAL = new Set(['BHD', 'KWD', 'OMR', 'TND', 'JOD', 'IQD']);

export function minorUnitExponent(currency: CurrencyCode): number {
  if (ZERO_DECIMAL.has(currency)) return 0;
  if (THREE_DECIMAL.has(currency)) return 3;
  return 2;
}

export function money(major: number, currency: CurrencyCode): Money {
  const factor = 10 ** minorUnitExponent(currency);
  return { amount: Math.round(major * factor), currency };
}

export function zero(currency: CurrencyCode): Money {
  return { amount: 0, currency };
}

export function toMajor(m: Money): number {
  return m.amount / 10 ** minorUnitExponent(m.currency);
}

function assertSame(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(
      `Currency mismatch: ${a.currency} vs ${b.currency}. Convert through the FX service before arithmetic.`,
    );
  }
}

export function add(...parts: Money[]): Money {
  if (parts.length === 0) throw new Error('add() needs at least one Money value');
  const head = parts[0]!;
  return parts.slice(1).reduce((acc, p) => {
    assertSame(acc, p);
    return { amount: acc.amount + p.amount, currency: acc.currency };
  }, head);
}

export function subtract(a: Money, b: Money): Money {
  assertSame(a, b);
  return { amount: a.amount - b.amount, currency: a.currency };
}

export function multiply(a: Money, factor: number): Money {
  return { amount: Math.round(a.amount * factor), currency: a.currency };
}

export function divide(a: Money, divisor: number): Money {
  if (divisor === 0) throw new Error('Division by zero in Money.divide');
  return { amount: Math.round(a.amount / divisor), currency: a.currency };
}

export function compare(a: Money, b: Money): number {
  assertSame(a, b);
  return a.amount - b.amount;
}

export function isGreater(a: Money, b: Money): boolean {
  return compare(a, b) > 0;
}

export function max(a: Money, b: Money): Money {
  return compare(a, b) >= 0 ? a : b;
}

export function formatMoney(m: Money, locale = 'en-IN'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
    maximumFractionDigits: minorUnitExponent(m.currency),
  }).format(toMajor(m));
}
