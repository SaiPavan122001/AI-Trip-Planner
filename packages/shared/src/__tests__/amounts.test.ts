import { describe, expect, it } from 'vitest';
import { parseRupees } from '../amounts.js';

/**
 * Reading money from words. The cases in the second block are real ways the
 * old readers went wrong: a date, a head count or a length of stay that sat
 * near a word like "budget" or "under" was read as an amount of rupees.
 */

describe('parseRupees: amounts that are stated', () => {
  it.each([
    ['budget ₹80,000', 80_000],
    ['Rs 2,50,000', 250_000],
    ['INR 45000', 45_000],
    ['80000 rupees', 80_000],
    ['around 50k', 50_000],
    ['under 1.5 lakh', 150_000],
    ['a budget of 2 lakhs', 200_000],
    ['budget 80000', 80_000],
    ['do not exceed 65,000', 65_000],
    ['we must not go over 90000', 90_000],
    ['no more than ₹1,20,000 for everything', 120_000],
  ])('%s', (text, expected) => {
    expect(parseRupees(text)).toBe(expected);
  });

  it('finds a real amount that follows a rejected candidate in the same sentence', () => {
    expect(parseRupees('budget trip on 12 December with a budget of ₹70,000')).toBe(70_000);
  });
});

describe('parseRupees: numbers that are not money', () => {
  it.each([
    'a budget trip to Goa on 12 December',
    'Budget trip to Goa on 12 December for 2 people',
    'leave on 12 December, keep the budget as it is',
    'under 5 people please',
    'at most 4 people',
    'max 3 nights',
    'within 2 days of the festival',
    'no more than 2 stops',
    'a budget hotel, 4 stars, for 3 nights',
    'I have 3 kids',
    'budget 2030',
    'under 12 december',
    'budget 500',
  ])('%s', (text) => {
    expect(parseRupees(text)).toBeNull();
  });

  it('does not read "confirm" as anything about money', () => {
    expect(parseRupees('please confirm the booking for 12 December')).toBeNull();
  });
});
