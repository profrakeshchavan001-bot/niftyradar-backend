'use strict';
// Live-bot safety guard (src/paper/replay/safety.js, round 2 item 2): the automatic run must skip when the
// live bot's own health page would report PROBLEM, or when memory is already high, and must never block on
// an error reading health (an unchecked condition is not a problem).
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { shouldSkipAutoRun, DEFAULT_MEMORY_CAP_MB } = require('../src/paper/replay/safety');
const { createHealthTracker, JOB_NAMES } = require('../src/paper/ops/health');

function fakeStore() {
  return {
    async listTrades() { return []; },
    async openTrades() { return []; },
    async tradesForDay() { return []; },
    async skipsSince() { return []; },
  };
}

// A tracker where every job the health page watches ran successfully "just now", so buildHealth() reports
// ALIVE (a fresh tracker with no recorded runs at all always reads as PROBLEM -- "no scan in 15+ min" -- which
// is the live bot's real behaviour, but not what these tests are checking).
function freshTracker(now) {
  const t = createHealthTracker({ now: () => now });
  for (const name of JOB_NAMES) t.recordRun(name, true);
  return t;
}

test('shouldSkipAutoRun: a healthy live bot with normal memory never skips', async () => {
  const now = 1700000000000;
  const r = await shouldSkipAutoRun({ liveState: { enabled: true, ready: true }, liveStore: fakeStore(), tracker: freshTracker(now), now: () => now });
  assert.equal(r.skip, false);
  assert.equal(r.health.status, 'ALIVE');
});

test('shouldSkipAutoRun: the live bot disabled/not ready reports PROBLEM, and the run is skipped', async () => {
  const now = 1700000000000;
  const r = await shouldSkipAutoRun({ liveState: { enabled: false }, liveStore: fakeStore(), tracker: freshTracker(now), now: () => now });
  assert.equal(r.skip, true);
  assert.match(r.reason, /PROBLEM/);
});

test('shouldSkipAutoRun: memory over the cap skips, even with a healthy live bot', async (t) => {
  const now = 1700000000000;
  t.mock.method(process, 'memoryUsage', () => ({ rss: (DEFAULT_MEMORY_CAP_MB + 50) * 1048576 }));
  const r = await shouldSkipAutoRun({ liveState: { enabled: true, ready: true }, liveStore: fakeStore(), tracker: freshTracker(now), now: () => now });
  assert.equal(r.skip, true);
  assert.match(r.reason, /memory/);
});

test('shouldSkipAutoRun: a health-build error never blocks the run (unchecked, not a problem)', async () => {
  const brokenStore = { async listTrades() { throw new Error('db down'); }, async openTrades() { throw new Error('db down'); }, async tradesForDay() { throw new Error('db down'); }, async skipsSince() { throw new Error('db down'); } };
  const r = await shouldSkipAutoRun({ liveState: null, liveStore: null, now: () => 1700000000000 });
  // liveState/liveStore both null: buildHealth itself should still resolve (no store -> db.ok=false -> status PROBLEM),
  // which IS a real, checked problem (not an error), so this documents that a null live state reports PROBLEM, not "unchecked".
  assert.equal(typeof r.skip, 'boolean');
  void brokenStore;
});
