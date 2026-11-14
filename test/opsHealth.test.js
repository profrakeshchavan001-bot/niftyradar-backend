'use strict';
// Overnight ops glance page: GET /api/paper/health (src/paper/ops/health.js). All expected numbers below
// are worked out by hand in the comments next to them, not copied from the function's own output.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHealthTracker, buildHealth, JOB_NAMES, STALE_MS } = require('../src/paper/ops/health');
const { createMemoryStore } = require('../paperbot/store');

const NOW = Date.UTC(2026, 10, 14, 4, 0); // Sat 14 Nov 2026, 09:30 IST

test('tracker.wrap records a successful run and clears any earlier error for that job', async () => {
  let now = NOW;
  const tracker = createHealthTracker({ now: () => now });
  const ok = tracker.wrap('nseScan', async () => 'done');
  await ok();
  const snap = tracker.snapshot();
  assert.deepEqual(snap.jobs.nseScan, { lastRunAt: NOW, ok: true, error: null });
  assert.deepEqual(snap.errors, []);
});

test('tracker.wrap records a failed run, rethrows, and keeps the last 10 errors (oldest dropped)', async () => {
  let now = NOW;
  const tracker = createHealthTracker({ now: () => now });
  const failing = tracker.wrap('cryptoScan', async () => { throw new Error('boom'); });
  for (let i = 0; i < 12; i++) {
    now = NOW + i; // 12 distinct timestamps, one per failure
    await assert.rejects(failing(), /boom/);
  }
  const snap = tracker.snapshot();
  assert.equal(snap.errors.length, 10); // ring buffer caps at 10 of the 12 failures
  assert.equal(snap.errors[0].at, NOW + 11); // newest first
  assert.equal(snap.errors[9].at, NOW + 2); // the two oldest (at NOW, NOW+1) were dropped
  assert.equal(snap.jobs.cryptoScan.ok, false);
  assert.equal(snap.jobs.cryptoScan.error, 'boom');
});

test('ALIVE: bot ready, all 4 jobs scanned just now, database reachable, no errors', async () => {
  const tracker = createHealthTracker({ now: () => NOW });
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const store = createMemoryStore();
  const h = await buildHealth({ tracker, store, state: { enabled: true, ready: true }, now: NOW });
  assert.equal(h.status, 'ALIVE');
  assert.equal(h.database.ok, true);
  assert.equal(h.openTrades.nse, 0);
  assert.equal(h.openTrades.crypto, 0);
  assert.equal(h.today.trades, 0);
  assert.equal(h.today.skips, 0);
  for (const name of JOB_NAMES) assert.equal(h.jobs[name].stale, false);
});

test('PROBLEM: a job has not scanned in over 15 minutes (overnight brief rule: stale after 15 min)', async () => {
  const tracker = createHealthTracker({ now: () => NOW });
  tracker.recordRun('nseScan', true);
  tracker.recordRun('nseMonitor', true);
  tracker.recordRun('cryptoScan', true);
  // cryptoMonitor never recorded: "never" counts as stale too, not "unchecked and therefore fine"
  const store = createMemoryStore();
  const later = NOW + STALE_MS + 60000; // 16 minutes after the last recorded run
  const h = await buildHealth({ tracker, store, state: { enabled: true, ready: true }, now: later });
  assert.equal(h.status, 'PROBLEM');
  assert.match(h.reason, /no scan in 15\+ min/);
  assert.ok(h.reason.includes('cryptoMonitor'));
  assert.equal(h.jobs.nseScan.minutesAgo, 16);
  assert.equal(h.jobs.cryptoMonitor.lastRunAt, null);
});

test('PROBLEM: database unreachable is reported honestly, counts stay null (never guessed)', async () => {
  const tracker = createHealthTracker({ now: () => NOW });
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const brokenStore = { listTrades: async () => { throw new Error('ECONNREFUSED'); } };
  const h = await buildHealth({ tracker, store: brokenStore, state: { enabled: true, ready: true }, now: NOW });
  assert.equal(h.status, 'PROBLEM');
  assert.equal(h.database.ok, false);
  assert.match(h.reason, /ECONNREFUSED/);
  assert.equal(h.openTrades.nse, null);
  assert.equal(h.today.trades, null);
});

test('PROBLEM: no store configured at all (PAPER_DATABASE_URL unset at startup, state.store still null)', async () => {
  const tracker = createHealthTracker({ now: () => NOW });
  const h = await buildHealth({ tracker, store: null, state: { enabled: true, ready: false }, now: NOW });
  assert.equal(h.status, 'PROBLEM');
  assert.match(h.reason, /still starting/);
  assert.equal(h.database.ok, false);
});

test('PROBLEM: bot disabled via PAPER_BOT_ENABLED=false', async () => {
  const tracker = createHealthTracker({ now: () => NOW });
  const h = await buildHealth({ tracker, store: null, state: { enabled: false, ready: false }, now: NOW });
  assert.match(h.reason, /disabled/);
});

test('today counts only count rows dated today, not yesterday (hand-checked: 1 of 2 trades, 1 of 2 skips)', async () => {
  const tracker = createHealthTracker({ now: () => NOW });
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const store = createMemoryStore();
  const today = '2026-11-14';
  const yesterday = '2026-11-13';
  await store.insertTrade({ market: 'nse', symbol: 'RELIANCE', trade_date: today, status: 'open' });
  await store.insertTrade({ market: 'nse', symbol: 'TCS', trade_date: yesterday, status: 'closed' });
  await store.insertSkip({ market: 'nse', symbol: 'INFY', skip_date: today, reason: 'test' });
  await store.insertSkip({ market: 'nse', symbol: 'WIPRO', skip_date: yesterday, reason: 'test' });
  const h = await buildHealth({ tracker, store, state: { enabled: true, ready: true }, now: NOW });
  assert.equal(h.today.trades, 1);
  assert.equal(h.today.skips, 1);
  assert.equal(h.openTrades.nse, 1); // only the open RELIANCE trade
});

test('data sources are reported as "unchecked", never a made-up status', async () => {
  const tracker = createHealthTracker({ now: () => NOW });
  const h = await buildHealth({ tracker, store: createMemoryStore(), state: { enabled: true, ready: true }, now: NOW });
  assert.equal(h.dataSources.binance.status, 'unchecked');
  assert.equal(h.dataSources.yahoo.status, 'unchecked');
  assert.equal(h.dataSources.dhan.status, 'unchecked');
});
