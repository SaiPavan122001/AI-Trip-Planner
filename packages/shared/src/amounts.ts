/**
 * Reading an amount of rupees out of a person's own words.
 *
 * Two places in the system read money from free text: the Requirements Agent's
 * rules and the keyword fallback that interprets a change request. They used to
 * carry separate readers, and each accepted a bare number after a word such as
 * "budget" or "under". That is how "a budget trip to Goa on 12 December" became
 * a budget of 12 rupees and "at most 4 people" a limit of 4 rupees.
 *
 * The rule here: a number is money only when the words say so, or when it is a
 * plausible bare amount that is not obviously something else (a date, a head
 * count, a number of nights, a year).
 */

const UNITS: Record<string, number> = {
  k: 1_000,
  thousand: 1_000,
  lakh: 100_000,
  lakhs: 100_000,
  lac: 100_000,
  lacs: 100_000,
  crore: 10_000_000,
  crores: 10_000_000,
  cr: 10_000_000,
};

/**
 * The smallest bare figure (no ₹, "rupees" or unit beside it) read as a trip
 * amount. Nobody plans a trip on a budget of ₹500, and every date, head count
 * and length of stay is below it.
 */
export const MIN_BARE_AMOUNT = 1_000;

const NUM = '(\\d[\\d,]*(?:\\.\\d+)?)';
const UNIT = '(k|thousand|lakhs?|lacs?|crores?|cr)';
const MONTHS =
  'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';
/** What a number is when one of these follows it: not money. */
const NOT_MONEY_AFTER = new RegExp(
  `^\\s*(?:${MONTHS}|st|nd|rd|th|nights?|days?|weeks?|months?|years?|hours?|hrs?|mins?|minutes?|people|persons?|adults?|children|child|kids?|infants?|travell?ers?|guests?|pax|rooms?|beds?|stops?|changes?|stars?|km|kms|kilometres?|kilometers?|%)\\b`,
  'i',
);
/** ...and what it is when one of these comes right before it. */
const NOT_MONEY_BEFORE = new RegExp(`(?:${MONTHS})\\.?\\s*$`, 'i');

function scaled(digits: string, unit: string | undefined): number | null {
  const base = Number(digits.replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const amount = Math.round(base * (unit ? (UNITS[unit.toLowerCase()] ?? 1) : 1));
  return amount > 0 ? amount : null;
}

/**
 * An amount in rupees the text states: "₹80,000", "Rs 80000", "80k", "1.5
 * lakh", "INR 2,50,000", or a plausible bare figure straight after a money
 * word ("budget 80000"). Null when it states none. The first amount found, in
 * order of how sure the words are, is the one returned.
 */
export function parseRupees(text: string): number | null {
  const t = text.toLowerCase();

  // Each attempt is scanned in full, so one candidate that turns out to be a
  // date does not hide a real amount later in the same sentence.
  const attempts: Array<{ re: RegExp; unitGroup: number | null; bare: boolean }> = [
    { re: new RegExp(`(?:₹|\\brs\\.?|\\binr)\\s*${NUM}(?:\\s*${UNIT}\\b)?`, 'g'), unitGroup: 2, bare: false },
    { re: new RegExp(`\\b${NUM}\\s*(?:rupees?|rs\\b|inr\\b)`, 'g'), unitGroup: null, bare: false },
    { re: new RegExp(`\\b${NUM}\\s*${UNIT}\\b`, 'g'), unitGroup: 2, bare: false },
    {
      re: new RegExp(
        `\\b(?:budget|spend|spending|cost|costs|under|below|within|exceed|go over|spend more than|cross|limit|maximum|max|at most|no more than)\\b[^0-9.,;!?]{0,20}${NUM}(?:\\s*${UNIT}\\b)?`,
        'g',
      ),
      unitGroup: 2,
      bare: true,
    },
  ];

  for (const { re, unitGroup, bare } of attempts) {
    for (const m of t.matchAll(re)) {
      const digits = m[1]!;
      const unit = unitGroup === null ? undefined : m[unitGroup];
      const end = (m.index ?? 0) + m[0].length;
      const start = (m.index ?? 0) + m[0].length - digits.length - (unit ? unit.length : 0);

      // A unit or a currency word settles it. Otherwise the neighbours decide.
      if (!unit && !/(?:₹|\brs\b|\binr\b|rupees?)/.test(m[0])) {
        if (NOT_MONEY_AFTER.test(t.slice(end))) continue;
        if (NOT_MONEY_BEFORE.test(t.slice(0, start))) continue;
      }
      const amount = scaled(digits, unit);
      if (amount === null) continue;
      if (bare && !unit) {
        if (amount < MIN_BARE_AMOUNT) continue;
        // 2030 written without a comma is a year far more often than a budget.
        if (!digits.includes(',') && amount >= 1900 && amount <= 2100) continue;
      }
      return amount;
    }
  }
  return null;
}
