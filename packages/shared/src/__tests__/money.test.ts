import { describe, expect, it } from 'vitest';
import { add, divide, formatMoney, money, multiply, subtract, toMajor } from '../money.js';

describe('money', () => {
  it('stores major units as integer minor units', () => {
    expect(money(1500, 'INR')).toEqual({ amount: 150_000, currency: 'INR' });
    expect(money(12.34, 'EUR')).toEqual({ amount: 1234, currency: 'EUR' });
  });

  it('respects currencies whose minor unit is not 1/100', () => {
    expect(money(1500, 'JPY')).toEqual({ amount: 1500, currency: 'JPY' });
    expect(toMajor(money(1500, 'JPY'))).toBe(1500);
  });

  it('refuses arithmetic across currencies rather than guessing a rate', () => {
    expect(() => add(money(100, 'INR'), money(100, 'EUR'))).toThrow(/Currency mismatch/);
    expect(() => subtract(money(100, 'INR'), money(1, 'USD'))).toThrow(/Currency mismatch/);
  });

  it('survives the repeated summing a trip total requires without drift', () => {
    // 0.1 + 0.2 in floating point is the classic failure; a trip total sums
    // dozens of components, so the error would be user-visible.
    const cents = Array.from({ length: 10 }, () => money(0.1, 'EUR'));
    expect(add(...cents)).toEqual({ amount: 100, currency: 'EUR' });
  });

  it('rounds to whole minor units when splitting', () => {
    expect(divide(money(100, 'EUR'), 3)).toEqual({ amount: 3333, currency: 'EUR' });
    expect(multiply(money(100, 'EUR'), 0.25)).toEqual({ amount: 2500, currency: 'EUR' });
  });

  it('formats in the currency it is denominated in', () => {
    expect(formatMoney(money(82_000, 'INR'))).toContain('82,000');
  });
});
