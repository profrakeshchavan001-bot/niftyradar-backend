'use strict';
// Full /api/paper/health fixture run (docs/REPLAY.md "fixtures, not live" convention; same hand-built
// candles as test/paperReplay.test.js): runs the REAL createBot() against the REAL createHealthTracker()
// wrapping (same wiring paperbot/index.js uses), with nseScan and cryptoScan deliberately fired
// CONCURRENTLY - the exact overlap (same IST date, different markets, both calling store.tradesForDay())
// that used to crash cryptoScan with `"undefined" is not valid JSON"` (paperbot/store.js createCachedStore,
// fixed in this PR). Proves every job buildHealth() reports on finishes with ok:true, repeatedly, under
// the real race condition, not just once by luck.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBot } = require('../paperbot/bot');
const { createMemoryStore, createCachedStore } = require('../paperbot/store');
const { createHealthTracker, buildHealth, JOB_NAMES } = require('../src/paper/ops/health');
const CS = require('./fixtures/cryptoScenario');

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'paper_replay.json'), 'utf8'));
const MIN = 60000;
const FIVE = 5 * MIN;

test('/api/paper/health fixture run: nseScan and cryptoScan firing concurrently, same IST date, never crash and every job reports ok:true', async () => {
  // Production shape: ONE cachedStore shared by every job (paperbot/index.js: `const store = createCachedStore(createPgStore(...))`).
  // createMemoryStore() stands in for the database (same convention `createMemoryStore`'s own header comment
  // and every existing paperbot/ test already uses: "used by tests ... as a loud fallback").
  const store = createCachedStore(createMemoryStore());
  const tracker = createHealthTracker();

  // NSE fixture harness (same candles/clock shape as test/paperReplay.test.js's nseHarness).
  const nseClock = { t: fx.nse.sessionStart };
  const nseClosedAt = () => fx.nse.candles.filter((k) => k.t + FIVE <= nseClock.t);
  const nseSpotNow = () => nseClosedAt().at(-1)?.c ?? null;
  const nse = {
    ranking: () => {
      const price = nseSpotNow();
      if (!price) return null;
      return [{ symbol: 'TESTSTK', price, pct: -1.8, volume: 1000000 }, { symbol: 'AAA', price: 100, pct: 2.5, volume: 1000000 }];
    },
    spot: (s) => (s === 'TESTSTK' ? nseSpotNow() : null),
    candles: async (s) => ({ candles: s === 'TESTSTK' ? fx.nse.candles.filter((k) => k.t <= nseClock.t) : [], source: 'replay_fixture' }),
    optionQuote: async () => ({ ltp: 20, strike: 490, expiry: '2026-11-26', spot: nseSpotNow() }),
    lotSize: () => 500,
    news: async () => [],
  };

  // Crypto fixture harness (same candles/clock shape as test/paperReplay.test.js's crypto replay test).
  const cryptoCandles = CS.build();
  const cryptoClock = { t: CS.scanTime(cryptoCandles) };
  const crypto = {
    candles: async (s) => (s === 'BTCUSDT' ? cryptoCandles.filter((k) => k.t <= cryptoClock.t) : []),
    price: async () => 102.2,
    usdtInr: async () => ({ rate: 88, source: 'test' }),
  };

  // Same IST calendar date on both sides at the moment of the race (what makes nseScan's and cryptoScan's
  // store.tradesForDay(market, date) calls collide on the SAME key prefix, `|<date>`, in the shared cache).
  const nseBot = createBot({ store, nse, crypto: null, now: () => nseClock.t, log: () => {} });
  const cryptoBot = createBot({ store, nse: null, crypto, now: () => cryptoClock.t, log: () => {} });

  const jobs = {
    nseScan: tracker.wrap('nseScan', nseBot.nseScan),
    nseMonitor: tracker.wrap('nseMonitor', nseBot.nseMonitor),
    cryptoScan: tracker.wrap('cryptoScan', cryptoBot.cryptoScan),
    cryptoMonitor: tracker.wrap('cryptoMonitor', cryptoBot.cryptoMonitor),
    shadowMonitor: tracker.wrap('shadowMonitor', cryptoBot.shadowMonitor),
  };
  assert.deepEqual(Object.keys(jobs).sort(), [...JOB_NAMES, 'shadowMonitor'].sort()); // every job buildHealth() tracks by name, plus shadowMonitor (also health-tracked in production, paperbot/index.js)

  // Fire every job CONCURRENTLY, repeatedly, advancing both clocks each round - the exact cron-overlap
  // shape (nseScan every 5 min during market hours, cryptoScan every 5 min 24/7, no cross-job overlap
  // guard) that produced the original bug in production.
  for (let round = 0; round < 8; round++) {
    await Promise.all([jobs.nseScan(), jobs.cryptoScan(), jobs.nseMonitor(), jobs.cryptoMonitor(), jobs.shadowMonitor()]);
    nseClock.t += FIVE;
    cryptoClock.t += FIVE;
  }

  const now = Math.max(nseClock.t, cryptoClock.t);
  const state = { enabled: true, ready: true, holidays: [], store, crypto: {}, yahoo: {}, nse: {} };
  const h = await buildHealth({ tracker, store, state, now });

  // The actual assertion the task asked for: every job buildHealth() reports on is ok:true, with no error.
  for (const name of JOB_NAMES) {
    assert.equal(h.jobs[name].ok, true, `job ${name} reported ok:false (error: ${h.jobs[name].error})`);
    assert.equal(h.jobs[name].error, null, `job ${name} has a recorded error`);
  }
  assert.deepEqual(h.recentErrors, [], 'no job recorded an error anywhere in the run');

  // And the tracker's OWN view (every job it was asked to track, shadowMonitor included) agrees.
  const snap = tracker.snapshot();
  for (const name of Object.keys(jobs)) {
    assert.equal(snap.jobs[name].ok, true, `tracker says ${name} failed: ${snap.jobs[name].error}`);
  }
  assert.equal(snap.errors.length, 0);
});
