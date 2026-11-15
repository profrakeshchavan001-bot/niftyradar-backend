'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createWatchdog } = require('../src/paper/ops/watchdog');
const { createHealthTracker } = require('../src/paper/ops/health');

test('watchdog: forces a run of a 24/7 job that has gone stale beyond staleMs', async () => {
  let now = 1000000;
  const tracker = createHealthTracker({ now: () => now });
  tracker.recordRun('scalpWideMonitor', true);
  let calls = 0;
  const jobRegistry = { scalpWideMonitor: async () => { calls += 1; } };
  const wd = createWatchdog({ tracker, jobRegistry, log: () => {}, staleMs: 180000, now: () => now });
  now += 60000; // 1 min later: not stale yet
  wd.checkOnce();
  assert.strictEqual(calls, 0);
  now += 200000; // now 260s since the last run: stale
  wd.checkOnce();
  await Promise.resolve(); await Promise.resolve();
  assert.strictEqual(calls, 1);
});

test('watchdog: never forces a job listed in skipNames (NSE jobs correctly idle outside market hours)', async () => {
  let now = 1000000;
  const tracker = createHealthTracker({ now: () => now });
  tracker.recordRun('nseScan', true);
  let calls = 0;
  const jobRegistry = { nseScan: async () => { calls += 1; } };
  const wd = createWatchdog({ tracker, jobRegistry, log: () => {}, staleMs: 10000, now: () => now, skipNames: ['nseScan'] });
  now += 10 * 60 * 60 * 1000; // 10 hours later (NSE closed overnight)
  wd.checkOnce();
  assert.strictEqual(calls, 0);
});

test('watchdog: a job that never ran (no tracker entry at all) is also forced', async () => {
  const tracker = createHealthTracker();
  let calls = 0;
  const jobRegistry = { trendSmcMonitor: async () => { calls += 1; } };
  const wd = createWatchdog({ tracker, jobRegistry, log: () => {}, staleMs: 1000 });
  wd.checkOnce();
  await Promise.resolve(); await Promise.resolve();
  assert.strictEqual(calls, 1);
});

test('watchdog: a forced run that throws is caught and logged, never escapes checkOnce', async () => {
  const tracker = createHealthTracker();
  const logs = [];
  const jobRegistry = { scalpMonitor: async () => { throw new Error('boom'); } };
  const wd = createWatchdog({ tracker, jobRegistry, log: (m) => logs.push(m), staleMs: 1000 });
  assert.doesNotThrow(() => wd.checkOnce());
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(logs.some((l) => l.includes('forced run failed')));
});

test('watchdog: start()/stop() wires a real interval timer without throwing', () => {
  const tracker = createHealthTracker();
  const wd = createWatchdog({ tracker, jobRegistry: {}, log: () => {}, checkEveryMs: 50 });
  wd.start();
  wd.stop();
});
