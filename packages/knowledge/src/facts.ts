/**
 * The checkable things in a sentence: amounts, numbers with units, dates, and
 * whether it says "not". Used to compare a claim with its source and to notice
 * two sources that disagree. Deliberately small and lexical: it can prove that a
 * figure is *absent* from a source, which is what catches an invented price; it
 * cannot prove that a sentence *means* what its source means, and nothing
 * here claims to.
 */

const UNIT: Record<string, string> = {
  day: 'day', days: 'day', hour: 'hour', hours: 'hour', hr: 'hour', hrs: 'hour', minute: 'minute', minutes: 'minute', min: 'minute', mins: 'minute',
  kg: 'kg', kgs: 'kg', kilogram: 'kg', kilograms: 'kg', km: 'km', kms: 'km', kilometre: 'km', kilometres: 'km', kilometer: 'km', kilometers: 'km',
  percent: '%', '%': '%', person: 'person', persons: 'person', people: 'person', passenger: 'person', passengers: 'person',
  year: 'year', years: 'year', month: 'month', months: 'month', week: 'week', weeks: 'week',
};

/** Rupee amounts and numbers, each with its unit if one follows: `₹500`, `10%`, `7day`, `15kg`, `2026-03-01`. */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  let t = text.normalize('NFKC').toLowerCase();

  // ISO dates first, so their digits are not read again as numbers.
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_m, y: string, mo: string, d: string) => {
    out.add(`${y}-${mo}-${d}`);
    return ' ';
  });
  // Rupee amounts in their spellings.
  t = t.replace(/(?:₹|\brs\.?|\binr)\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:rupees?|₹)/g, (_m, a: string | undefined, b: string | undefined) => {
    out.add(`₹${canonical(a ?? b ?? '')}`);
    return ' ';
  });
  t.replace(/(\d[\d,]*(?:\.\d+)?)\s*(%|percent|[a-z]+)?/g, (_m, n: string, unit: string | undefined) => {
    const u = unit ? UNIT[unit] : undefined;
    out.add(`${canonical(n)}${u ?? ''}`);
    return ' ';
  });
  return out;
}

function canonical(n: string): string {
  const cleaned = n.replace(/,/g, '');
  const value = Number(cleaned);
  return Number.isFinite(value) ? String(value) : cleaned;
}

const NEGATION = /\b(not|no|never|cannot|can't|isn't|aren't|won't|don't|doesn't|without|prohibited|banned|forbidden|refused|non-refundable|nonrefundable|unavailable|excluded)\b/;

export function hasNegation(text: string): boolean {
  return NEGATION.test(text.toLowerCase().normalize('NFKC'));
}

/** Words that promise more than a source usually does. A claim that uses one must find it in its source. */
export const CERTAINTY_WORDS = /\b(guarantee[ds]?|guaranteed|definitely|certainly|always|never|100%|absolutely|without exception|no exceptions|for sure)\b/i;

export function urlsIn(text: string): string[] {
  return text.match(/\bhttps?:\/\/[^\s<>"')\]]+/gi) ?? [];
}
