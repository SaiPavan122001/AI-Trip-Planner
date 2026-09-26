import { describe, expect, it } from 'vitest';
import { IsoDate, sanitizeModificationParameters } from '../index.js';

describe('sanitizing modification parameters', () => {
  it('keeps valid fields and names the invalid ones', () => {
    const { parameters, rejected } = sanitizeModificationParameters({
      mode: 'train',
      earliestDeparture: '9am',
      priorities: ['cheapest', 'fastest'],
      adults: 0,
    });
    expect(parameters).toEqual({ mode: 'train', priorities: ['cheapest', 'fastest'] });
    expect(rejected.sort()).toEqual(['adults', 'earliestDeparture']);
  });

  it('rejects fields it does not know rather than passing them through', () => {
    const { parameters, rejected } = sanitizeModificationParameters({
      confirmBooking: true,
      __proto__polluted: 'x',
    });
    expect(parameters).toEqual({});
    expect(rejected.sort()).toEqual(['__proto__polluted', 'confirmBooking']);
  });

  it('ignores absent values rather than counting them as rejected', () => {
    expect(sanitizeModificationParameters({ mode: null, category: undefined })).toEqual({
      parameters: {},
      rejected: [],
    });
  });

  it('refuses the same priority twice', () => {
    expect(sanitizeModificationParameters({ priorities: ['safest', 'safest'] }).rejected).toEqual([
      'priorities',
    ]);
  });
});

describe('ISO dates', () => {
  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2025-02-29', '2026-1-5'])('refuses %s', (d) => {
    expect(IsoDate.safeParse(d).success).toBe(false);
  });

  it.each(['2026-11-10', '2028-02-29', '2026-12-31'])('accepts %s', (d) => {
    expect(IsoDate.safeParse(d).success).toBe(true);
  });
});
