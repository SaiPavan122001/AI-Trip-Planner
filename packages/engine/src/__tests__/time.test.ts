import { describe, expect, it } from 'vitest';
import { datesBetween, instantFrom, localParts, minutesBetween, utcFromLocal } from '../time.js';

describe('timezone arithmetic', () => {
  it('converts a local wall-clock time to the correct instant', () => {
    // 08:00 in Kolkata is UTC+5:30, year-round.
    expect(utcFromLocal('2026-11-10', '08:00', 'Asia/Kolkata')).toBe('2026-11-10T02:30:00.000Z');
  });

  it('round-trips a local time through UTC and back', () => {
    const utc = utcFromLocal('2026-07-04', '14:45', 'Europe/Paris');
    const back = localParts(utc, 'Europe/Paris');
    expect(back.date).toBe('2026-07-04');
    expect(back.time).toBe('14:45');
  });

  it('applies the right offset either side of a daylight-saving change', () => {
    // Paris is UTC+1 in January and UTC+2 in July. A planner that assumed one
    // offset would put every summer itinerary an hour out.
    expect(utcFromLocal('2026-01-15', '12:00', 'Europe/Paris')).toBe('2026-01-15T11:00:00.000Z');
    expect(utcFromLocal('2026-07-15', '12:00', 'Europe/Paris')).toBe('2026-07-15T10:00:00.000Z');
  });

  it('reads a provider timestamp that carries its own offset', () => {
    expect(instantFrom('2026-11-10T08:00:00+05:30', null)).toBe('2026-11-10T02:30:00.000Z');
  });

  it('interprets an offset-less provider timestamp in the segment timezone', () => {
    expect(instantFrom('2026-11-10T08:00:00', 'Asia/Kolkata')).toBe('2026-11-10T02:30:00.000Z');
  });

  it('refuses an offset-less timestamp with no timezone rather than assuming UTC', () => {
    // Silently treating it as UTC would shift the whole itinerary.
    expect(() => instantFrom('2026-11-10T08:00:00', null)).toThrow(/no offset/i);
  });

  it('measures the gap between two instants in minutes', () => {
    expect(minutesBetween('2026-11-10T02:30:00.000Z', '2026-11-10T03:45:00.000Z')).toBe(75);
    expect(minutesBetween('2026-11-10T03:45:00.000Z', '2026-11-10T02:30:00.000Z')).toBe(-75);
  });

  it('lists the local dates a range spans', () => {
    const dates = datesBetween(
      '2026-11-10T18:00:00.000Z',
      '2026-11-12T04:00:00.000Z',
      'Asia/Kolkata',
    );
    // 18:00 UTC is already the 10th at 23:30 local; 04:00 UTC is the 12th.
    expect(dates).toEqual(['2026-11-10', '2026-11-11', '2026-11-12']);
  });
});
