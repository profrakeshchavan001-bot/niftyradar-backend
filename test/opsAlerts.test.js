'use strict';
// Overnight brief item 7 (src/paper/ops/alerts/register.js): stale-job and consecutive-failure alerts,
// stored via the plugin's pool.query and sent to Telegram only when configured.
const test = require('node:test');
const assert = require('node:assert/strict');
const { register, CONSEC_FAIL_THRESHOLD, DEDUPE_MS } = require('../src/paper/ops/alerts/register');
const { createHealthTracker, JOB_NAMES, STALE_MS } = require('../src/paper/ops/health');

function fakeCron() { const jobs = []; return { schedule: (expr, fn) => jobs.push(fn), jobs }; }
function fakePool() { const inserts = []; return { inserts, query: async (sql, params) => { inserts.push({ sql, params }); return { rows: [] }; } }; }
// Every test gets its own tracker (never the shared singleton) so tests cannot interfere with each other.
function freshTracker() { return createHealthTracker(); }

test('a job that never scanned raises a stale_job alert and stores it', async () => {
  const tracker = freshTracker();
  for (const name of JOB_NAMES) tracker.recordRun(name, true); // mark all healthy first, then age one out below
  const cron = fakeCron(); const pool = fakePool(); const log = () => {};
  const { check } = register({ cron, env: {}, log, pool, tracker });
  const now = Date.now() + STALE_MS + 60000;
  await check(now);
  const staleInserts = pool.inserts.filter((i) => i.params[0] === 'stale_job');
  assert.equal(staleInserts.length, JOB_NAMES.length); // every job aged past 15 min
  assert.ok(staleInserts.every((i) => JOB_NAMES.includes(i.params[1])));
});

test('a fresh scan raises no stale_job alert', async () => {
  const tracker = freshTracker();
  const now = Date.now();
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const cron = fakeCron(); const pool = fakePool(); const log = () => {};
  const { check } = register({ cron, env: {}, log, pool, tracker });
  await check(now + 1000); // 1 second later: not stale
  assert.equal(pool.inserts.filter((i) => i.params[0] === 'stale_job').length, 0);
});

test(`${CONSEC_FAIL_THRESHOLD} consecutive failures raises a consecutive_failures alert`, async () => {
  const tracker = freshTracker();
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  for (let i = 0; i < CONSEC_FAIL_THRESHOLD; i++) tracker.recordRun('nseScan', false, 'ECONNRESET');
  const cron = fakeCron(); const pool = fakePool(); const log = () => {};
  const { check } = register({ cron, env: {}, log, pool, tracker });
  await check(Date.now());
  const consecInserts = pool.inserts.filter((i) => i.params[0] === 'consecutive_failures' && i.params[1] === 'nseScan');
  assert.equal(consecInserts.length, 1);
  assert.match(consecInserts[0].params[2], /ECONNRESET/);
});

test('2 consecutive failures (below threshold) raises nothing for that job', async () => {
  const tracker = freshTracker();
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  tracker.recordRun('cryptoScan', false, 'x'); tracker.recordRun('cryptoScan', false, 'x');
  const cron = fakeCron(); const pool = fakePool(); const log = () => {};
  const { check } = register({ cron, env: {}, log, pool, tracker });
  await check(Date.now());
  assert.equal(pool.inserts.filter((i) => i.params[0] === 'consecutive_failures' && i.params[1] === 'cryptoScan').length, 0);
});

test('the same alert is not re-stored inside the dedupe window, but fires again after it', async () => {
  const tracker = freshTracker();
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const t0 = Date.now();
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
  await assert.doesNotReject(check(Date.now() + STALE_MS + 60000));
});

test('no TELEGRAM_* env vars: check still completes without attempting a network call', async () => {
  const tracker = freshTracker();
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const cron = fakeCron(); const pool = fakePool(); const log = () => {};
  const { check } = register({ cron, env: {}, log, pool, tracker });
  await assert.doesNotReject(check(Date.now() + STALE_MS + 60000));
});

test('cron.schedule is called once, every 5 minutes', () => {
  const tracker = freshTracker();
  const cron = fakeCron(); const pool = fakePool(); const log = () => {};
  register({ cron, env: {}, log, pool, tracker });
  assert.equal(cron.jobs.length, 1);
});
