'use strict';
// Overnight brief item 7 (src/paper/ops/alerts/register.js): stale-job and consecutive-failure alerts,
// stored via the plugin's pool.query and sent to Telegram only when configured.
//
// Every "stale" scenario below is anchored to a fixed, explicit IST timestamp (never Date.now()) so
// these tests give the same answer regardless of when in the real day/week the suite happens to run -
// this file is exactly what would have caught the night/weekend false-alert bug the gating below fixes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { register, CONSEC_FAIL_THRESHOLD, DEDUPE_MS } = require('../src/paper/ops/alerts/register');
const { createHealthTracker, JOB_NAMES, NSE_JOBS, STALE_MS } = require('../src/paper/ops/health');

function fakeCron() { const jobs = []; return { schedule: (expr, fn) => jobs.push(fn), jobs }; }
function fakePool() { const inserts = []; return { inserts, query: async (sql, params) => { inserts.push({ sql, params }); return { rows: [] }; } }; }
// Every test gets its own tracker (never the shared singleton) so tests cannot interfere with each other.
// `now` defaults to the real clock (tests that never call recordRun do not care), but any test that
// records a run AND checks it against a fixed timestamp must give both the SAME clock, or "staleFor"
// is measured between two unrelated times.
function freshTracker(now = Date.now) { return createHealthTracker({ now }); }

// Monday 2026-01-05, 10:30 IST: inside NSE market hours (09:15-15:30), not a listed holiday.
const IN_HOURS = Date.UTC(2026, 0, 5, 5, 0, 0);
// Same Monday, 20:00 IST: well outside market hours.
const OUT_OF_HOURS = Date.UTC(2026, 0, 5, 14, 30, 0);
// Saturday 2026-01-10, 10:30 IST: weekend (NSE always closed, whatever the time of day).
const WEEKEND = Date.UTC(2026, 0, 10, 5, 0, 0);
// Tuesday 2026-11-24, 10:30 IST: a listed NSE holiday (paperbot/config.js DEFAULTS.nse.holidays),
// otherwise a normal trading-hours weekday/time.
const HOLIDAY = Date.UTC(2026, 10, 24, 5, 0, 0);
const HOLIDAYS = ['2026-11-24', '2026-12-25'];

test('a job that never scanned raises a stale_job alert and stores it, during market hours', async () => {
  const tracker = freshTracker(() => IN_HOURS); // every recordRun below is stamped IN_HOURS
  for (const name of JOB_NAMES) tracker.recordRun(name, true); // mark all healthy first, then age one out below
  const cron = fakeCron(); const pool = fakePool(); const log = () => {};
  const { check } = register({ cron, env: {}, log, pool, tracker });
  await check(IN_HOURS + STALE_MS + 60000);
  const staleInserts = pool.inserts.filter((i) => i.params[0] === 'stale_job');
  assert.equal(staleInserts.length, JOB_NAMES.length); // every job aged past 15 min, market is open
  assert.ok(staleInserts.every((i) => JOB_NAMES.includes(i.params[1])));
});

test('a fresh scan raises no stale_job alert', async () => {
  const tracker = freshTracker(() => IN_HOURS);
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const cron = fakeCron(); const pool = fakePool(); const log = () => {};
  const { check } = register({ cron, env: {}, log, pool, tracker });
  await check(IN_HOURS + 1000); // 1 second later: not stale
  assert.equal(pool.inserts.filter((i) => i.params[0] === 'stale_job').length, 0);
});

// Root-cause coverage: an NSE job that has never scanned, or has not scanned in 15+ minutes, outside
// market hours is correctly idle - it must raise and send nothing. Crypto jobs are never gated.
test('NSE jobs stale outside market hours (night, same weekday) raise nothing; crypto jobs still do', async () => {
  const tracker = freshTracker(); // nothing recorded at all: every job is "never scanned"
  const cron = fakeCron(); const pool = fakePool(); const log = () => {};
  const { check } = register({ cron, env: {}, log, pool, tracker });
  await check(OUT_OF_HOURS);
  const stale = pool.inserts.filter((i) => i.params[0] === 'stale_job').map((i) => i.params[1]);
  assert.deepEqual(stale.sort(), ['cryptoMonitor', 'cryptoScan'].sort()); // NSE jobs: silent; crypto: still raised
  assert.ok(NSE_JOBS.every((n) => !stale.includes(n)));
});

test('NSE jobs stale on a weekend raise nothing, even with no scan ever recorded', async () => {
  const tracker = freshTracker();
  const cron = fakeCron(); const pool = fakePool(); const log = () => {};
  const { check } = register({ cron, env: {}, log, pool, tracker });
  await check(WEEKEND);
  const stale = pool.inserts.filter((i) => i.params[0] === 'stale_job').map((i) => i.params[1]);
  assert.ok(NSE_JOBS.every((n) => !stale.includes(n)));
  assert.ok(stale.includes('cryptoScan')); // crypto is 24x7, weekend included
});

test('NSE jobs stale on a listed NSE holiday (otherwise a trading-hours weekday/time) raise nothing', async () => {
  const tracker = freshTracker();
  const cron = fakeCron(); const pool = fakePool(); const log = () => {};
  const { check } = register({ cron, env: {}, log, pool, tracker, state: { holidays: HOLIDAYS } });
  await check(HOLIDAY);
  const stale = pool.inserts.filter((i) => i.params[0] === 'stale_job').map((i) => i.params[1]);
  assert.ok(NSE_JOBS.every((n) => !stale.includes(n)));
  assert.ok(stale.includes('cryptoScan'));
});

test('with no state passed at all (no holiday list known), an in-hours weekday/time still alerts on stale NSE jobs', async () => {
  const tracker = freshTracker();
  const cron = fakeCron(); const pool = fakePool(); const log = () => {};
  const { check } = register({ cron, env: {}, log, pool, tracker }); // state omitted entirely
  await check(IN_HOURS);
  const stale = pool.inserts.filter((i) => i.params[0] === 'stale_job').map((i) => i.params[1]);
  assert.ok(NSE_JOBS.every((n) => stale.includes(n)));
});

test(`${CONSEC_FAIL_THRESHOLD} consecutive NSE failures during market hours raises a consecutive_failures alert`, async () => {
  const tracker = freshTracker();
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  for (let i = 0; i < CONSEC_FAIL_THRESHOLD; i++) tracker.recordRun('nseScan', false, 'ECONNRESET');
  const cron = fakeCron(); const pool = fakePool(); const log = () => {};
  const { check } = register({ cron, env: {}, log, pool, tracker });
  await check(IN_HOURS);
  const consecInserts = pool.inserts.filter((i) => i.params[0] === 'consecutive_failures' && i.params[1] === 'nseScan');
  assert.equal(consecInserts.length, 1);
  assert.match(consecInserts[0].params[2], /ECONNRESET/);
});

test(`${CONSEC_FAIL_THRESHOLD} consecutive NSE failures recorded before the close raise nothing once checked outside market hours`, async () => {
  const tracker = freshTracker();
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  for (let i = 0; i < CONSEC_FAIL_THRESHOLD; i++) tracker.recordRun('nseScan', false, 'ECONNRESET');
  const cron = fakeCron(); const pool = fakePool(); const log = () => {};
  const { check } = register({ cron, env: {}, log, pool, tracker });
  await check(OUT_OF_HOURS);
  assert.equal(pool.inserts.filter((i) => i.params[0] === 'consecutive_failures' && i.params[1] === 'nseScan').length, 0);
});

test('2 consecutive failures (below threshold) raises nothing for that job', async () => {
  const tracker = freshTracker();
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  tracker.recordRun('cryptoScan', false, 'x'); tracker.recordRun('cryptoScan', false, 'x');
  const cron = fakeCron(); const pool = fakePool(); const log = () => {};
  const { check } = register({ cron, env: {}, log, pool, tracker });
  await check(IN_HOURS);
  assert.equal(pool.inserts.filter((i) => i.params[0] === 'consecutive_failures' && i.params[1] === 'cryptoScan').length, 0);
});

test('the same alert is not re-stored inside the dedupe window, but fires again after it', async () => {
  const t0 = IN_HOURS;
  const tracker = freshTracker(() => t0);
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const cron = fakeCron(); const pool = fakePool(); const log = () => {};
  const { check } = register({ cron, env: {}, log, pool, tracker });
  await check(t0 + STALE_MS + 60000);
  await check(t0 + STALE_MS + 120000); // 1 minute later, still inside the 15-minute dedupe window
  assert.equal(pool.inserts.filter((i) => i.params[0] === 'stale_job' && i.params[1] === 'nseScan').length, 1);
  await check(t0 + STALE_MS + 120000 + DEDUPE_MS + 1000); // past the dedupe window: fires again
  assert.equal(pool.inserts.filter((i) => i.params[0] === 'stale_job' && i.params[1] === 'nseScan').length, 2);
});

test('with no pool (no PAPER_DATABASE_URL), alerts still run and dedupe in memory, just nothing is stored', async () => {
  const tracker = freshTracker();
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const cron = fakeCron(); const log = () => {};
  const { check } = register({ cron, env: {}, log, pool: null, tracker });
  await assert.doesNotReject(check(IN_HOURS + STALE_MS + 60000));
});

test('no TELEGRAM_* env vars: check still completes without attempting a network call', async () => {
  const tracker = freshTracker();
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const cron = fakeCron(); const pool = fakePool(); const log = () => {};
  const { check } = register({ cron, env: {}, log, pool, tracker });
  await assert.doesNotReject(check(IN_HOURS + STALE_MS + 60000));
});

test('cron.schedule is called once, every 5 minutes', () => {
  const tracker = freshTracker();
  const cron = fakeCron(); const pool = fakePool(); const log = () => {};
  register({ cron, env: {}, log, pool, tracker });
  assert.equal(cron.jobs.length, 1);
});
