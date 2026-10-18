#!/usr/bin/env node
/**
 * Opt-in LIVE checks of the real provider adapters, with your own credentials
 * from the root .env. Read only: nothing here books, pays, or creates an order.
 *
 *   npm run build
 *   npm run live:check                   # cheap checks only
 *   npm run live:check -- --searches     # also one real search per Hotelbeds API and Google Places
 *   npm run live:check -- --llm          # also one tiny model request (uses a few tokens)
 *
 * Each line is PASS, FAIL or SKIPPED (not configured). PASS means a real
 * request succeeded just now with what is in .env, and says nothing about
 * production inventory or account permissions beyond that one call.
 * Credentials are never printed. Some calls are billed (Google) or counted
 * against a test account's daily quota (Hotelbeds evaluation keys: 50 a day).
 */
import { config } from 'dotenv';

config({ path: new URL('../.env', import.meta.url) });

const args = new Set(process.argv.slice(2));
const withSearches = args.has('--searches');
const withLlm = args.has('--llm');

const { ProviderRegistry, loadProvidersEnv } = await import('@trip/providers');

const results = [];
const record = (name, status, detail) => {
  results.push({ name, status });
  console.log(`${status.padEnd(8)} ${name}${detail ? ` - ${detail}` : ''}`);
};
// `configured` is false (not set up), true (go), or the reason an opt-in check was not asked for.
const gate = (configured, asked, reason) => (!configured ? false : asked ? true : reason);
const run = async (name, configured, fn) => {
  if (configured === false) return record(name, 'SKIPPED', 'not configured');
  if (typeof configured === 'string') return record(name, 'SKIPPED', configured);
  try {
    const res = await fn();
    if (res && res.status === 'ok') return record(name, 'PASS', res.note ?? '');
    return record(name, 'FAIL', res ? `${res.status}: ${res.message ?? ''}` : 'no answer');
  } catch (err) {
    // Only the kind of error: a message could contain a URL or a header.
    return record(name, 'FAIL', err instanceof Error ? err.name : 'error');
  }
};

let registry;
try {
  registry = new ProviderRegistry(loadProvidersEnv(process.env));
} catch (err) {
  console.error(`The configuration in .env is not valid: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exit(2);
}

const future = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const place = (name, lat, lon, tz) => ({
  id: `live:${name}`,
  name,
  displayName: name,
  coordinates: { lat, lon },
  countryCode: 'XX',
  countryName: 'Live check',
  timezone: tz,
  airports: [],
  source: 'live-check',
  resolvedAt: new Date().toISOString(),
});

// ----------------------------------------------------------- places, routes
// The public Nominatim asks for a real contact address; the template's placeholder is not one.
const realContact = !/example.(com|invalid)|your-email/i.test(process.env.NOMINATIM_USER_AGENT ?? '');
await run('Nominatim (place lookup)', gate(registry.geocoding.length > 0, realContact, 'set NOMINATIM_USER_AGENT to a real contact address (the template value is a placeholder)'), async () => {
  const res = await registry.geocoding[0].resolvePlace('Hyderabad', { limit: 1 });
  return res.status === 'ok' ? { status: 'ok', note: `${res.data.length} place(s)` } : res;
});

await run('Routing (first configured: Google Routes or OSRM)', registry.routing.length > 0, async () => {
  const res = await registry.routing[0].route({
    from: { lat: 17.385, lon: 78.4867 },
    to: { lat: 17.4399, lon: 78.4983 },
    profile: 'driving',
  });
  return res.status === 'ok' ? { status: 'ok', note: `${registry.routing[0].descriptor.label}: ${res.data.distanceKm} km` } : res;
});

// ------------------------------------------------------------------ Duffel
await run('Duffel (airport lookup, test or live per token)', registry.duffel !== null, async () => {
  const res = await registry.duffel.nearestAirports({ lat: 17.385, lon: 78.4867 });
  return res.status === 'ok' ? { status: 'ok', note: `${registry.duffel.descriptor.label}: ${res.data.map((a) => a.iataCode).join(',')}` } : res;
});

// -------------------------------------------------------------- Google Places
const googlePlaces = registry.activities.find((p) => p.descriptor.id === 'google-places');
await run('Google Places (one nearby search; billed)', gate(Boolean(googlePlaces), withSearches, 'add --searches'), async () => {
  const res = await googlePlaces.searchActivities({
    destination: place('Hyderabad', 17.385, 78.4867, 'Asia/Kolkata'),
    near: { lat: 17.385, lon: 78.4867 },
    radiusKm: 5,
    categories: [],
    accessibilityNeeds: [],
    currency: 'INR',
    limit: 3,
  });
  return res.status === 'ok' ? { status: 'ok', note: `${res.data.length} place(s)` } : res;
});

// ----------------------------------------------------------------- Hotelbeds
const hotelbeds = (id) =>
  [...registry.hotels, ...registry.activities, ...registry.quotedTransfers].find((p) => p.descriptor.id === id);
const hbHotels = hotelbeds('hotelbeds-hotels');
const hbActivities = hotelbeds('hotelbeds-activities');
const hbTransfers = hotelbeds('hotelbeds-transfers');

await run('Hotelbeds Hotels (status call)', Boolean(hbHotels), async () => {
  const res = await hbHotels.health();
  return res.status === 'ok' ? { status: 'ok', note: hbHotels.descriptor.label } : res;
});
await run('Hotelbeds Hotels (one availability search)', gate(Boolean(hbHotels), withSearches, 'add --searches (counts against a test account quota)'), async () => {
  const res = await hbHotels.searchHotels({
    destination: place('Barcelona', 41.3874, 2.1686, 'Europe/Madrid'),
    checkIn: future(60),
    checkOut: future(62),
    rooms: 1,
    party: { adults: 2, children: 0, infants: 0 },
    minCategory: null,
    maxPricePerNight: null,
    currency: 'INR',
    amenities: [],
    freeCancellationOnly: false,
    near: null,
    radiusKm: 5,
    limit: 3,
  });
  return res.status === 'ok' ? { status: 'ok', note: `${res.data.length} hotel(s); prices are in the contract currency` } : res;
});
await run('Hotelbeds Activities (one availability search)', gate(Boolean(hbActivities), withSearches, 'add --searches (counts against a test account quota)'), async () => {
  const res = await hbActivities.searchActivities({
    destination: place('Barcelona', 41.3874, 2.1686, 'Europe/Madrid'),
    near: { lat: 41.3874, lon: 2.1686 },
    radiusKm: 10,
    categories: [],
    accessibilityNeeds: [],
    currency: 'INR',
    limit: 3,
    window: { from: future(60), to: future(62), party: { adults: 2, children: 0, infants: 0 } },
  });
  return res.status === 'ok' ? { status: 'ok', note: `${res.data.length} activity(ies)` } : res;
});
await run('Hotelbeds Transfers (one availability search, documented sample route)', gate(Boolean(hbTransfers), withSearches, 'add --searches (counts against a test account quota)'), async () => {
  // The route in Hotelbeds' own example: a hotel (ATLAS 265) to Palma airport (PMI).
  const res = await hbTransfers.quoteTransfers({
    from: { type: 'ATLAS', code: '265' },
    to: { type: 'IATA', code: 'PMI' },
    at: `${future(60)}T08:00:00Z`,
    timezone: 'Europe/Madrid',
    party: { adults: 2, children: 0, infants: 0 },
    currency: 'INR',
  });
  return res.status === 'ok' ? { status: 'ok', note: `${res.data.length} service(s)` } : res;
});

// --------------------------------------------------------------------- Gemini
const llmUrl = process.env.LLM_BASE_URL?.replace(/\/$/, '');
await run('Language model (LLM_* settings; one tiny request)', gate(Boolean(llmUrl && process.env.LLM_MODEL), withLlm, 'add --llm'), async () => {
  const res = await fetch(`${llmUrl}/chat/completions`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', ...(process.env.LLM_API_KEY ? { authorization: `Bearer ${process.env.LLM_API_KEY}` } : {}) },
    body: JSON.stringify({ model: process.env.LLM_MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return { status: `http ${res.status}`, message: '' };
  const body = await res.json();
  return Array.isArray(body.choices) ? { status: 'ok', note: process.env.LLM_LABEL ?? 'model answered' } : { status: 'unexpected', message: 'no choices in the answer' };
});

// ------------------------------------------------------------------------ Qrail
record('Qrail (trains)', 'SKIPPED', 'no adapter: endpoints are not publicly documented, see docs/providers.md');

const failed = results.filter((r) => r.status === 'FAIL').length;
const passed = results.filter((r) => r.status === 'PASS').length;
console.log(`\n${passed} passed, ${failed} failed, ${results.length - passed - failed} skipped.`);
console.log('PASS is one real, read-only request just now. It is not a statement about live inventory, prices or approvals.');
process.exit(failed > 0 ? 1 : 0);
