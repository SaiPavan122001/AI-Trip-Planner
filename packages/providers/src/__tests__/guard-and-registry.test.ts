import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError, z } from 'zod';
import { dedupeProviderNotes, fail, isOk, noteFromFailure, ok, statusClass, statusLabel } from '@trip/shared';
import { InvalidResponseError, NetworkError, TimeoutError, toProviderFailure } from '../http.js';
import { IsolatingPolicy, readItems, readResponse, type ProviderCall } from '../guard.js';
import { ResilientPolicy } from '../policy.js';
import { ProviderRegistry } from '../registry.js';
import { loadProvidersEnv } from '../config.js';

const call: ProviderCall = { provider: 'p', providerLabel: 'Provider P', capability: 'flights', operation: 'searchFlights' };
const provenance = { provider: 'p', providerLabel: 'Provider P', retrievedAt: '2026-01-01T00:00:00.000Z', validUntil: null, searchId: null, attribution: null };

describe('what a provider outcome means to a traveller', () => {
  it.each([
    ['ok', 'ok'],
    ['not_configured', 'not_available'],
    ['unsupported_capability', 'not_available'],
    ['unavailable', 'failed'],
    ['invalid_request', 'failed'],
    ['timeout', 'timed_out'],
    ['rate_limited', 'rate_limited'],
    ['no_availability', 'empty'],
    ['unsupported_route', 'empty'],
    ['invalid_response', 'unusable'],
  ])('%s is %s', (status, cls) => {
    expect(statusClass(status)).toBe(cls);
  });

  it('treats a status it has never heard of as a failure, and labels every class', () => {
    expect(statusClass('from_a_newer_version')).toBe('failed');
    expect(new Set(['ok', 'not_configured', 'unavailable', 'timeout', 'rate_limited', 'no_availability', 'invalid_response'].map(statusLabel)).size).toBe(7);
  });
});

describe('turning what went wrong into a failure that says so', () => {
  const at = (err: unknown) => toProviderFailure(err, 'p', 'Provider P');
  it('separates an unreachable provider, a timeout and an unusable answer', () => {
    expect(at(new NetworkError('u', 'ECONNRESET')).status).toBe('unavailable');
    expect(at(new TimeoutError('u', 1000)).status).toBe('timeout');
    expect(at(new InvalidResponseError('u')).status).toBe('invalid_response');
  });

  it('treats a schema mismatch and the errors that bad data causes as an unusable answer', () => {
    const zodError = (() => {
      try {
        z.object({ a: z.string() }).parse({});
      } catch (e) {
        return e as ZodError;
      }
      throw new Error('unreachable');
    })();
    expect(at(zodError).status).toBe('invalid_response');
    expect(at(new TypeError("Cannot read properties of undefined (reading 'map')")).status).toBe('invalid_response');
    expect(at(new RangeError('bad')).status).toBe('invalid_response');
  });

  it('never repeats a vendor error or a stack trace to the traveller', () => {
    const f = at(new Error('secret internal detail at /srv/app.js:12'));
    expect(f.status).toBe('unavailable');
    expect(f.message).not.toMatch(/secret|srv/);
  });
});

describe('reading a response defensively', () => {
  const Row = z.object({ id: z.string(), price: z.string().regex(/^\d+$/) });

  it('keeps good rows, counts bad ones, and keeps the raw row of each good one', () => {
    const rows = [{ id: 'a', price: '10', extra: 1 }, { id: 'b' }, { id: 'c', price: 'x' }];
    const { valid, dropped, allInvalid } = readItems(rows, Row);
    expect(valid.map((v) => v.data.id)).toEqual(['a']);
    expect(valid[0]!.raw).toEqual({ id: 'a', price: '10', extra: 1 });
    expect(dropped).toBe(2);
    expect(allInvalid).toBe(false);
  });

  it('says when nothing at all was usable, and not for an empty list', () => {
    expect(readItems([{}, {}], Row).allInvalid).toBe(true);
    expect(readItems([], Row).allInvalid).toBe(false);
  });

  it('refuses a payload of the wrong shape with a reason naming the field', () => {
    expect(() => readResponse(Row, { id: 3 }, 'thing')).toThrow(InvalidResponseError);
    expect(() => readResponse(Row, { id: 3 }, 'thing')).toThrow(/id/);
  });
});

describe('the default provider policy', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('passes a good result straight through', async () => {
    const result = ok([1], provenance);
    expect(await new IsolatingPolicy().execute(call, async () => result)).toBe(result);
  });

  it('turns a throw into a failure tagged with what was being asked for', async () => {
    const res = await new IsolatingPolicy().execute(call, async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'data')");
    });
    expect(isOk(res)).toBe(false);
    expect(res).toMatchObject({ status: 'invalid_response', provider: 'p', capability: 'flights' });
  });

  it('turns a synchronous throw into a failure too', async () => {
    const res = await new IsolatingPolicy().execute(call, () => {
      throw new Error('boom');
    });
    expect(res).toMatchObject({ status: 'unavailable', capability: 'flights' });
  });

  it('tags a returned failure with its capability without changing anything else', async () => {
    const original = fail('no_availability', 'p', 'Provider P', 'nothing');
    const res = await new IsolatingPolicy().execute(call, async () => original);
    expect(res).toMatchObject({ status: 'no_availability', message: 'nothing', capability: 'flights' });
  });

  it('stops waiting at the deadline and says the provider timed out', async () => {
    const policy = new IsolatingPolicy({ deadlineMs: 2_000 });
    const pending = policy.execute(call, () => new Promise<never>(() => undefined));
    await vi.advanceTimersByTimeAsync(2_001);
    const res = await pending;
    expect(res).toMatchObject({ status: 'timeout', capability: 'flights' });
    expect((res as { message: string }).message).toMatch(/2 seconds/);
  });
});

describe('a note says what it is about', () => {
  const registry = () => new ProviderRegistry(loadProvidersEnv({}));

  it('keeps Flights and Hotels apart even though one vendor would serve both', () => {
    const flights = registry().missingCapabilityNote('flights', ['amadeus']);
    const hotels = registry().missingCapabilityNote('hotels', ['amadeus']);
    expect(flights.capability).toBe('flights');
    expect(hotels.capability).toBe('hotels');
    expect(flights.message).toMatch(/flight/i);
    expect(flights.message).not.toMatch(/hotel/i);
    expect(hotels.message).toMatch(/hotel/i);
    expect(hotels.message).not.toMatch(/flight/i);
    expect(flights.message).not.toBe(hotels.message);

    const merged = dedupeProviderNotes([noteFromFailure(flights), noteFromFailure(hotels), noteFromFailure(flights)]);
    expect(merged.map((n) => n.capability)).toEqual(['flights', 'hotels']);
  });

  it('still merges the same note repeated across searches', () => {
    const f = registry().missingCapabilityNote('trains', ['rail']);
    expect(dedupeProviderNotes([noteFromFailure(f), noteFromFailure(f)])).toHaveLength(1);
  });

  it('gives each capability its own words', () => {
    const r = registry();
    const messages = (['flights', 'hotels', 'trains', 'buses', 'activities', 'transfers', 'self_drive', 'geocoding'] as const).map(
      (c) => r.missingCapabilityNote(c, ['amadeus', 'rail', 'bus', 'google-maps', 'osrm', 'nominatim']).message,
    );
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('has a policy on the registry that every call can go through', () => {
    // Phase 5: the default is the resilient policy (isolation, time budget and
    // circuit breaking); the isolation behaviour itself is still tested below.
    expect(registry().policy).toBeInstanceOf(ResilientPolicy);
  });

  it('reads the call deadline from the environment and refuses nonsense', () => {
    expect(loadProvidersEnv({ PROVIDER_CALL_TIMEOUT_MS: '30000' }).policy.callTimeoutMs).toBe(30_000);
    expect(loadProvidersEnv({}).policy.callTimeoutMs).toBe(45_000);
    expect(() => loadProvidersEnv({ PROVIDER_CALL_TIMEOUT_MS: 'soon' })).toThrow(/PROVIDER_CALL_TIMEOUT_MS/);
    expect(() => loadProvidersEnv({ PROVIDER_CALL_TIMEOUT_MS: '0' })).toThrow(/PROVIDER_CALL_TIMEOUT_MS/);
  });
});
