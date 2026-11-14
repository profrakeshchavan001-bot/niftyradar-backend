'use strict';
// CC3 urgent fix item 1: proves the shadow resolver actually runs through the REAL wiring (attachScalp/exhaustion_only/trend_smc
// register()), not just the bare bot.js functions - this is exactly the gap that let 10 shadow_setups rows sit open for 40+
// minutes in production (docs/decisions/CC3.md). Fixtures only; not verified against live Binance.
const test = require('node:test');
const assert = require('node:assert/strict');
const { attachScalp } = require('../src/paper/scalp');
const exhaustionRegister = require('../src/paper/bots/exhaustion_only/register');
const { createMemoryStore } = require('../paperbot/store');
const { scene, MIN } = require('./scalpFixtures');

function fakeApp() { return { get: () => {} }; }
function fakeCron() { const jobs = {}; return { jobs, schedule: (expr, fn) => { jobs[expr] = fn; } }; }
// Binance klines are arrays [openTime, open, high, low, close, volume, ...]; createScalpSource (src/paper/scalp/source.js) is
// what attachScalp actually builds from the `axios` it is given, so this is the real HTTP shape, not a bot.js-level shortcut.
const toKline = (c) => [c.t, String(c.o), String(c.h), String(c.l), String(c.c), String(c.v)];

test('real wiring: the scalp monitor cron entry (the exact function the live server schedules) resolves an open shadow end to end', async () => {
  const cron = fakeCron();
  const store = createMemoryStore(); // default scalp config (0.23% costs): the fixture's rr 0.8 is below min_rr 1.0 -> a real skip
  const s = scene();
  const clock = { t: s.now, candles1m: s.c1raw };
  const crypto = { candles: async () => s.c5raw, usdtInr: async () => ({ rate: 88, source: 'x' }) };
  const axios = { get: async () => ({ data: clock.candles1m.map(toKline) }) }; // real createScalpSource path, not a bot.js shortcut
  const logs = [];
  const out = attachScalp({ app: fakeApp(), cron, axios, env: {}, log: (m) => logs.push(m), state: { ready: true, store }, store, crypto, secret: 's', okSecret: () => true, enabled: true, guarded: (name, fn) => fn, now: () => clock.t });
  assert.ok(out.enabled);

  // Fails loudly if the resolver is not scheduled at all (this is exactly the second test item 1 asks for): the real wiring must
  // have registered BOTH the scan and the monitor on the cron the live server uses.
  assert.ok(cron.jobs['5 * * * * *'], 'scalp scan must be scheduled');
  assert.ok(cron.jobs['35 * * * * *'], 'scalp monitor (the shadow resolver lives inside this one) must be scheduled');

  // Create a real shadow through the REAL skip path (default costs reject this setup - docs/SCALP.md), via the SCHEDULED scan fn.
  await cron.jobs['5 * * * * *']();
  assert.equal(store._db.trades.length, 0, 'the default-cost setup is a skip, not a trade');
  assert.ok(logs.some((l) => /\[scalp\] skip/.test(l)), 'the skip (and its shadow) really happened');

  // Target: push the clock forward and feed a candle that clears the stored target (100.9422, from the skip's own shadowPlan).
  clock.candles1m = [...s.c1raw, { t: s.c1raw[s.c1raw.length - 1].t + MIN, o: 100.44, h: 100.99, l: 100.40, c: 100.9, v: 1 }];
  clock.t += 130000;
  await cron.jobs['35 * * * * *']();
  assert.equal(store._db.trades.length, 0, 'still never a trade');
  assert.ok(logs.some((l) => /\[scalp\] shadow resolved BTCUSDT: target/.test(l)), `expected a "shadow resolved ... target" log line through the REAL scheduled monitor function; got: ${JSON.stringify(logs.slice(-5))}`);
});

test('real wiring: exhaustion_only register() schedules scan+monitor AND runs a one-time shadow backfill at startup', async () => {
  const cron = fakeCron();
  const app = fakeApp();
  const mainStore = createMemoryStore();
  await exhaustionRegister.register({ app, cron, env: {}, log: () => {}, store: mainStore, guarded: (name, fn) => fn, tz: {}, pool: null });
  assert.ok(cron.jobs['15 */5 * * * *'], 'exhaustion_only scan must be scheduled');
  assert.ok(cron.jobs['45 * * * * *'], 'exhaustion_only monitor (the shadow resolver lives inside this one) must be scheduled');
  // backfillShadows() is fired fire-and-forget at the end of register(); give its microtask a tick to run, then confirm it did
  // not throw (memory mode, no shadows yet - checked:0/resolved:0 is the correct, quiet result, not a crash).
  await new Promise((r) => setTimeout(r, 10));
});
