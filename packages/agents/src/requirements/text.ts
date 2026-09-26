/**
 * Reading facts out of a traveller's own words, in code.
 *
 * These are the checks the Requirements Agent's output has to survive: a date
 * or an amount the model reports is only accepted if the words it quotes really
 * say it. They are also what the rule-based fallback is built from, so the same
 * reading is applied whether or not a model was used.
 */

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const MONTH = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';

const pad = (n: number) => String(n).padStart(2, '0');

/** A real calendar date, or null. */
export function isoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2100) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Without a year, the next time that day comes round, counting today. */
function resolveYear(month: number, day: number, today: string): string | null {
  const thisYear = Number(today.slice(0, 4));
  const candidate = isoDate(thisYear, month, day);
  if (candidate && candidate >= today) return candidate;
  return isoDate(thisYear + 1, month, day);
}

/**
 * Every date the text states explicitly, in the order it states them. A date
 * has to be named (a day and a month, or an ISO date, or day/month/year):
 * "next Friday" and "in the holidays" are not dates this will invent.
 * Slash dates are day/month, as written in India.
 */
export function findDates(text: string, today: string): string[] {
  return findDateSpans(text, today).map((d) => d.iso);
}

/** As `findDates`, with the words each date was read from. */
export function findDateSpans(text: string, today: string): Array<{ iso: string; text: string }> {
  const found: Array<{ at: number; iso: string; text: string }> = [];
  const lower = text.toLowerCase();

  for (const m of lower.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const iso = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (iso) found.push({ at: m.index ?? 0, iso, text: m[0] });
  }

  // "12 to 16 December": both days share the month.
  for (const m of lower.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:to|-|–|until|till)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?:,?\\s+(\\d{4}))?\\b`, 'g'))) {
    const month = MONTHS[m[3]!]!;
    const year = m[4] ? Number(m[4]) : null;
    for (const [i, dayText] of [[0, m[1]!], [1, m[2]!]] as const) {
      const day = Number(dayText);
      const iso = year ? isoDate(year, month, day) : resolveYear(month, day, today);
      if (iso) found.push({ at: (m.index ?? 0) + i, iso, text: m[0] });
    }
  }

  for (const m of lower.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?:,?\\s+(\\d{4}))?\\b`, 'g'))) {
    const month = MONTHS[m[2]!]!;
    const day = Number(m[1]);
    const iso = m[3] ? isoDate(Number(m[3]), month, day) : resolveYear(month, day, today);
    if (iso) found.push({ at: m.index ?? 0, iso, text: m[0] });
  }
  for (const m of lower.matchAll(new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'g'))) {
    const month = MONTHS[m[1]!]!;
    const day = Number(m[2]);
    const iso = m[3] ? isoDate(Number(m[3]), month, day) : resolveYear(month, day, today);
    if (iso) found.push({ at: m.index ?? 0, iso, text: m[0] });
  }
  for (const m of lower.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
    const iso = isoDate(Number(m[3]), Number(m[2]), Number(m[1]));
    if (iso) found.push({ at: m.index ?? 0, iso, text: m[0] });
  }

  const seen = new Set<string>();
  return found
    .sort((a, b) => a.at - b.at)
    .filter((f) => (seen.has(f.iso) ? false : (seen.add(f.iso), true)))
    .map((f) => ({ iso: f.iso, text: f.text }));
}

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
 * An amount in rupees the text states: "₹80,000", "Rs 80000", "80k", "1.5
 * lakh", "INR 2,50,000". Null when it states none. The first amount found is
 * the one returned.
 */
export function parseRupees(text: string): number | null {
  const t = text.toLowerCase();
  const NUM = '(\\d[\\d,]*(?:\\.\\d+)?)';
  const UNIT = '(k|thousand|lakhs?|lacs?|crores?|cr)';
  // In order of how sure the words make it that a number is money: a rupee
  // marker, then a rupee word after it, then a unit ("80k"), and only last a
  // bare number that sits right after a money word ("budget 80000"). A number
  // that is a date, a head-count or a day is never picked up by accident.
  const attempts: Array<[RegExp, number, number | null]> = [
    [new RegExp(`(?:₹|\\brs\\.?|\\binr)\\s*${NUM}(?:\\s*${UNIT}\\b)?`), 1, 2],
    [new RegExp(`\\b${NUM}\\s*(?:rupees?|rs\\b|inr\\b)`), 1, null],
    [new RegExp(`\\b${NUM}\\s*${UNIT}\\b`), 1, 2],
    [new RegExp(`\\b(?:budget|spend|spending|cost|costs|under|below|within|exceed|limit|maximum|max|at most|no more than)\\b[^0-9.,;!?]{0,20}${NUM}(?:\\s*${UNIT}\\b)?`), 1, 2],
  ];
  for (const [re, numGroup, unitGroup] of attempts) {
    const m = t.match(re);
    if (!m) continue;
    const base = Number(m[numGroup]!.replace(/,/g, ''));
    if (!Number.isFinite(base)) continue;
    const unit = unitGroup === null ? undefined : m[unitGroup];
    const amount = Math.round(base * (unit ? UNITS[unit]! : 1));
    if (amount > 0) return amount;
  }
  return null;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, a: 1, an: 1, single: 1, couple: 2, pair: 2,
};

/** Every whole number the text states, as digits or as words. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.toLowerCase().matchAll(/\b(\d+|[a-z]+)\b/g)) {
    const token = m[1]!;
    if (/^\d+$/.test(token)) out.push(Number(token));
    else if (token in NUMBER_WORDS) out.push(NUMBER_WORDS[token]!);
  }
  return out;
}

/** "HH:MM" from "9pm", "21:30", "9:30 am"; null if the text names no time. */
export function findTime(text: string): string | null {
  const t = text.toLowerCase();
  const m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ?? t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3];
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59) return null;
  return `${pad(hour)}:${pad(minute)}`;
}
