// End-to-end smoke run: the BUILT API (with its in-process worker) against a real,
// throwaway PostgreSQL, driven over HTTP the way the web app drives it.
//
//   npm run build && npm run smoke -w @trip/api
//   npm run build && npm run smoke -w @trip/api -- --split   (API and worker as separate processes)
//
// It starts PostgreSQL from the embedded-postgres dev dependency (no Docker),
// applies the migrations, and stands in for the place lookup and road router
// with a local stub, so it needs no network and no credentials. It exercises:
// an anonymous session, answering, a background search followed to the end,
// a pin surviving a re-plan, ownership, the cross-site write refusal, and
// account deletion. It removes everything it creates.
import EmbeddedPostgres from 'embedded-postgres';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\/]$/, '');
const require = createRequire(root + '/apps/api/package.json');
const dir = mkdtempSync(join(tmpdir(), 'smoke-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dir, user: 'trip', password: 'trip', port: 54331, persistent: false,
  initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {},
});
await pg.initialise();
await pg.start();
await pg.createDatabase('smoke');
const url = 'postgresql://trip:trip@127.0.0.1:54331/smoke';
execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
  cwd: root + '/apps/api', env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe',
});
console.log('migrations applied');

// Local stand-ins for the place lookup and the road router, so this smoke run needs no
// third-party service (the public Nominatim refuses placeholder contact addresses).
const places = {
  hyderabad: { place_id: 1, lat: '17.385', lon: '78.4867', display_name: 'Hyderabad, Telangana, India', name: 'Hyderabad', address: { country_code: 'in', country: 'India', state: 'Telangana', city: 'Hyderabad' } },
  bengaluru: { place_id: 2, lat: '12.9716', lon: '77.5946', display_name: 'Bengaluru, Karnataka, India', name: 'Bengaluru', address: { country_code: 'in', country: 'India', state: 'Karnataka', city: 'Bengaluru' } },
};
const stub = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/search') {
    const q = (u.searchParams.get('q') || '').toLowerCase();
    const hit = Object.entries(places).find(([k]) => q.includes(k));
    res.end(JSON.stringify(hit ? [hit[1]] : []));
  } else if (u.pathname.startsWith('/route/v1/')) {
    res.end(JSON.stringify({ code: 'Ok', routes: [{ distance: 575000, duration: 30600, geometry: '_p~iF~ps|U_ulLnnqC' }] }));
  } else res.end('{}');
});
await new Promise((r) => stub.listen(4199, '127.0.0.1', r));

let apiLog = '';
const split = process.argv.includes('--split');
const appEnv = {
    ...process.env, NODE_ENV: 'development', PORT: '4100', DATABASE_URL: url, LOG_LEVEL: 'warn',
    CORS_ORIGINS: 'http://localhost:3000', RUN_POLL_MS: '200',
    NOMINATIM_BASE_URL: 'http://127.0.0.1:4199', NOMINATIM_USER_AGENT: 'wayfare-smoke (dev@example.com)',
    NOMINATIM_MIN_INTERVAL_MS: '20', OSRM_BASE_URL: 'http://127.0.0.1:4199', OSRM_MIN_INTERVAL_MS: '10',
};
const api = spawn(process.execPath, ['dist/index.js'], {
  cwd: root + '/apps/api',
  env: { ...appEnv, RUN_WORKER: split ? 'false' : 'true' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
// In the split topology the API only queues searches and a separate process carries them out.
const worker = split
  ? spawn(process.execPath, ['dist/worker.js'], { cwd: root + '/apps/api', env: appEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  : null;
if (worker) {
  worker.stdout.on('data', (d) => (apiLog += d));
  worker.stderr.on('data', (d) => (apiLog += d));
}
api.stdout.on('data', (d) => (apiLog += d));
api.stderr.on('data', (d) => (apiLog += d));

const base = 'http://127.0.0.1:4100';
let cookie = '';
const call = async (method, path, body, extra = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', ...(cookie ? { cookie } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set && set.startsWith('tp_session=')) cookie = set.split(';')[0];
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed = true;
};

try {
  for (let i = 0; i < 40; i += 1) {
    try { if ((await fetch(base + '/health')).ok) break; } catch {}
    await sleep(250);
  }
  console.log(split ? 'topology: API and worker as separate processes' : 'topology: worker inside the API process');
  const health = await call('GET', '/health');
  check('health is ok on PostgreSQL', health.status === 200 && health.json.store.store === 'postgresql');

  const me0 = await call('GET', '/v1/me');
  check('a first visit has no user yet', me0.json.user === null);

  const future = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const back = new Date(Date.now() + 64 * 86400000).toISOString().slice(0, 10);
  const created = await call('POST', '/v1/trips', {
    originQuery: 'Hyderabad, India', destinationQuery: 'Bengaluru, India',
    departureDate: future, returnDate: back, travelers: { adults: 2 },
  });
  check('trip created with an anonymous session cookie', created.status === 201 && cookie.startsWith('tp_session='), created.status === 201 ? `status 201` : `status ${created.status} ${JSON.stringify(created.json).slice(0, 300)}`);
  const id = created.json?.trip?.id;

  // Answer whatever is asked until the trip can be planned.
  let q = created.json.trip.questionnaire;
  let payload = { key: 'budget.total', value: { amount: 6000000, currency: 'INR' } };
  for (let i = 0; i < 14 && q; i += 1) {
    const r = await call('POST', `/v1/trips/${id}/answers`, payload);
    if (r.status !== 200) { check('answer accepted', false, JSON.stringify(r.json)); break; }
    q = r.json.questionnaire;
    if (q.canPlan || !q.next) break;
    const n = q.next;
    const v = n.kind === 'single_choice' ? n.options[0].value
      : n.kind === 'multi_choice' ? n.options.map((o) => o.value)
      : n.kind === 'ranking' ? n.options.slice(0, Math.max(1, n.minSelections ?? 1)).map((o) => o.value)
      : n.kind === 'number' ? (n.min ?? 1) : n.kind === 'money' ? { amount: 6000000, currency: 'INR' }
      : n.kind === 'boolean' ? true : n.kind === 'time' ? '09:00' : 'x';
    payload = { key: n.key, value: v };
  }
  check('required questions answered', q?.canPlan === true);

  const started = await call('POST', `/v1/trips/${id}/plan`);
  check('planning returns 202 with a queued run', started.status === 202 && started.json.run.status === 'queued', `status ${started.status}`);
  const runId = started.json.run.id;
  let run = started.json.run;
  const seen = new Set();
  const t0 = Date.now();
  while (['queued', 'running'].includes(run.status) && Date.now() - t0 < 90000) {
    await sleep(400);
    run = (await call('GET', `/v1/trips/${id}/runs/${runId}`)).json.run;
    if (run.progress) seen.add(run.progress.step);
  }
  check('the search finished', run.status === 'succeeded', `${run.status} after ${Date.now() - t0}ms; steps seen: ${[...seen].join(', ')}`);

  const trip = (await call('GET', `/v1/trips/${id}`)).json;
  check('the trip carries plans and the last search', trip.trip.plans.length > 0 && trip.trip.lastSearch !== null, `${trip.trip.plans.length} plans; version ${trip.trip.version}`);
  const first = trip.trip.plans[0];
  check('no revalidation tokens are sent to the browser', !JSON.stringify(trip).includes('"revalidationToken":"'));

  // The multi-agent path: an explanation written from the plans' facts, and a trace of every stage.
  const stagesRun = (trip.trip.agentTrace ?? []).map((t) => t.stage).join(',');
  check(
    'the search went through the orchestrator and left an explanation and a trace',
    Boolean(trip.trip.narrative?.summary) && /Nothing has been booked/.test(trip.trip.narrative.summary) &&
      stagesRun === 'transport_agent,accommodation_agent,activity_agent,guidance,plan_search,validation,synthesis_agent',
    stagesRun,
  );
  const said = await call('POST', `/v1/trips/${id}/requirements`, { message: 'We like history and a relaxed pace. No buses please.' });
  check(
    'what the traveller says in words is read, checked and applied through the answers',
    said.status === 200 && said.json.applied.includes('transport.mode_openness') && said.json.keptForPlanning.includes('activity interest: history'),
    `status ${said.status}`,
  );
  const interpreted = await call('POST', '/v1/requirements/interpret', { message: 'a beach holiday from Pune' });
  check(
    'a request written in words says what is missing instead of inventing it',
    interpreted.status === 200 && interpreted.json.missing.some((m) => m.field === 'departure_date') && interpreted.json.tripInput === null,
  );
  check('what was said is kept with the trip for the planning agents', (await call('GET', `/v1/trips/${id}`)).json.trip.statedRequirements !== null);

  const pins = await call('PUT', `/v1/trips/${id}/pins`, { pins: ['outbound'] });
  check('a part can be pinned', pins.status === 200 && pins.json.trip.pins[0] === 'outbound');
  const replan = await call('POST', `/v1/trips/${id}/plan`);
  check('re-planning with a pin is accepted', replan.status === 202 && replan.json.pinsReleased.length === 0, `status ${replan.status}`);
  let r2 = replan.json.run;
  const t1 = Date.now();
  while (['queued', 'running'].includes(r2.status) && Date.now() - t1 < 90000) {
    await sleep(400);
    r2 = (await call('GET', `/v1/trips/${id}/runs/${r2.id}`)).json.run;
  }
  check('the re-plan finished', r2.status === 'succeeded', r2.status);

  const other = await fetch(base + `/v1/trips/${id}`, { headers: { origin: 'http://localhost:3000' } });
  check('someone without the cookie cannot open the trip', other.status === 404);

  const evil = await fetch(base + `/v1/trips/${id}/plan`, { method: 'POST', headers: { origin: 'https://evil.example', cookie } });
  check('a write from another site is refused', evil.status === 403);

  const del = await call('DELETE', '/v1/me', { confirm: 'delete my account' });
  check('the account can be deleted', del.status === 204);
  check('and the trip is gone', (await call('GET', `/v1/trips/${id}`)).status === 404);
} catch (err) {
  console.log('SMOKE ERROR', err);
  failed = true;
} finally {
  api.kill('SIGTERM');
  worker?.kill('SIGTERM');
  await sleep(500);
  stub.close();
  await pg.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
  if (failed) console.log('--- api log ---\n' + apiLog.slice(-3000));
  console.log(failed ? 'SMOKE FAILED' : 'SMOKE PASSED');
  process.exit(failed ? 1 : 0);
}
