/**
 * Timezone arithmetic, done with `Intl` rather than a date library.
 *
 * Every itinerary item is stored as a UTC instant plus the zone it happens in.
 * Scheduling then reduces to comparing instants, and display reduces to
 * formatting an instant in a zone. The alternative, carrying local wall-clock
 * strings around, quietly breaks the moment a trip crosses a zone or a DST
 * boundary, which is exactly when a traveller most needs the times to be right.
 */

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = cache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    cache.set(timeZone, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** YYYY-MM-DD in the target zone. */
  date: string;
  /** HH:MM in the target zone. */
  time: string;
  /** 0 = Sunday, matching the opening-hours model. */
  weekday: number;
}

export function localParts(instant: Date | string, timeZone: string): LocalParts {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  const parts = formatter(timeZone).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour') % 24;
  const minute = get('minute');
  const second = get('second');
  const iso = `${pad4(year)}-${pad(month)}-${pad(day)}`;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    date: iso,
    time: `${pad(hour)}:${pad(minute)}`,
    weekday: new Date(`${iso}T12:00:00Z`).getUTCDay(),
  };
}

/** Offset of a zone at a given instant, in minutes east of UTC. */
export function offsetMinutes(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * The inverse of `localParts`: given a wall-clock time in a zone, find the UTC
 * instant. Solved by iteration because a zone's offset depends on the instant
 * being computed. Two passes settle every real-world case, including the hour
 * either side of a DST change.
 */
export function utcFromLocal(date: string, time: string, timeZone: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  let guess = Date.UTC(y!, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0);
  for (let i = 0; i < 3; i += 1) {
    const offset = offsetMinutes(new Date(guess), timeZone);
    const corrected = Date.UTC(y!, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0) - offset * 60_000;
    if (corrected === guess) break;
    guess = corrected;
  }
  return new Date(guess).toISOString();
}

/**
 * Provider timestamps come in two flavours: with an offset (unambiguous) and
 * without (local wall time at the place it happens). The second kind is
 * interpreted in the segment's own zone, which is why segments carry one.
 */
export function instantFrom(providerTimestamp: string, timeZone: string | null): string {
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(providerTimestamp);
  if (hasOffset) return new Date(providerTimestamp).toISOString();
  const [datePart, timePart = '00:00'] = providerTimestamp.split('T');
  if (!timeZone) {
    // No zone to interpret it in. Treating it as UTC would silently shift the
    // whole itinerary, so the caller is told to supply a zone instead.
    throw new Error(
      `Timestamp "${providerTimestamp}" has no offset and no timezone was supplied to interpret it.`,
    );
  }
  return utcFromLocal(datePart!, timePart.slice(0, 5), timeZone);
}

/**
 * An instant written as local wall time in a zone, with that zone's offset:
 * `2026-11-10T14:10:00+05:30`. This is the shape transport segments use, so
 * code that reads the local date or hour straight from a segment timestamp
 * gets the local value, and the instant stays unambiguous.
 */
export function isoWithOffset(instant: string, timeZone: string): string {
  const p = localParts(instant, timeZone);
  const offset = offsetMinutes(new Date(instant), timeZone);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${p.date}T${p.time}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function addMinutes(instant: string, minutes: number): string {
  return new Date(Date.parse(instant) + minutes * 60_000).toISOString();
}

export function minutesBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 60_000);
}

export function formatLocal(instant: string, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${p.date} ${p.time}`;
}

/** Days covered by an instant range, in a given zone, as YYYY-MM-DD strings. */
export function datesBetween(startUtc: string, endUtc: string, timeZone: string): string[] {
  const start = localParts(startUtc, timeZone).date;
  const end = localParts(endUtc, timeZone).date;
  const out: string[] = [];
  let cursor = Date.parse(`${start}T12:00:00Z`);
  const last = Date.parse(`${end}T12:00:00Z`);
  while (cursor <= last) {
    out.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86_400_000;
  }
  return out;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}
