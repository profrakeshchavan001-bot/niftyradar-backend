'use strict';
// CC3 round 3 item 4 (stability): simulate a kill in the middle of a cycle - a fresh bot instance (new closures, same store, same
// in-flight candle) re-scans the exact candle an earlier "process" already decided on. Open trades must survive, there must be no
// double entry, and a shadow row for the same candle must stay unique. The memory store's dedupe (paperbot/store.js,
// src/paper/bots/exhaustion_only/store.js, src/paper/bots/trend_smc/store.js) mirrors the real unique-index behaviour exactly - this
// was also run by hand against a local Postgres 16 during this session (see docs/decisions/CC3.md); only the memory version is
// committed here, since the repo's `node --test test/*.test.js` run has no live Postgres of its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryStore } = require('../paperbot/store');
const { createScalpBot } = require('../src/paper/scalp/bot');
const { createMemoryExhaustionStore } = require('../src/paper/bots/exhaustion_only/store');
const { createExhaustionBot } = require('../src/paper/bots/exhaustion_only/bot');
const { createMemoryShadowStore } = require('../src/paper/shadow/store');
const { scene } = require('./scalpFixtures');

test('restart safety (scalp): the SAME candle re-scanned by a brand-new bot instance never double-enters; the open trade survives', async () => {
  const s = scene();
  const store = createMemoryStore(); // the "database" - survives the simulated kill
  const crypto = { candles: async () => s.c5raw, usdtInr: async () => ({ rate: 88, source: 'test' }) };
  const source1m = { candles1m: async () => s.c1raw };
  await store.setConfigIfMissing('scalp', { fee_pct_per_side: 0, slippage_pct: 0 }); // costs off so this candle actually trades

  // "Process 1": scans, enters BTCUSDT, then the process is killed (we just stop using this bot instance - nothing else happens).
  const bot1 = createScalpBot({ store, crypto, source1m, now: () => s.now, log: () => {} });
  const r1 = await bot1.cryptoScalpScan();
  assert.deepEqual(r1.entered, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  assert.equal(store._db.trades.length, 3);
  const openBefore = await store.openTrades('crypto_scalp');
  assert.equal(openBefore.length, 3);

  // "Restart": a brand-new bot instance (fresh closures, e.g. skipSeen is empty again), same store, same still-current candle.
  const bot2 = createScalpBot({ store, crypto, source1m, now: () => s.now, log: () => {} });
  const r2 = await bot2.cryptoScalpScan();
  assert.deepEqual(r2.entered, [], 'the restart finds the candle already traded - no new entries');
  assert.equal(store._db.trades.length, 3, 'still exactly 3 trades, not 6');
  const openAfter = await store.openTrades('crypto_scalp');
  assert.deepEqual(openAfter.map((t) => t.id), openBefore.map((t) => t.id), 'the open trades from before the kill are intact, same ids');
});

test('restart safety (exhaustion_only): a shadow row for the same candle stays unique across a restart', async () => {
  const store = createMemoryExhaustionStore();
  const shadowStore = createMemoryShadowStore();
  // Build the exact candle data item 4's test needs only for the shadow path: reuse the EXHAUSTION_ONLY_DEFAULTS min_rr lever so
  // the setup is skipped (shadow-tracked) rather than traded - the restart scenario is the same either way: re-scan the same candle.
  const { EXHAUSTION_ONLY_DEFAULTS } = require('../src/paper/bots/exhaustion_only/config');
  const MIN = 60000; const FIVE = 5 * MIN;
  const padded = (() => {
    const pad = Array.from({ length: 12 }, (_, i) => ({ t: i * FIVE, o: 110, h: 110.01, l: 109.99, c: 110, v: 1 }));
    const out = []; let px = 102.0; let t = 12 * FIVE;
    for (let i = 0; i < 32; i++) { out.push({ t, o: px, h: px + 0.025, l: px - 0.075, c: px - 0.05, v: 10 }); px = +(px - 0.05).toFixed(4); t += FIVE; }
    out.push({ t, o: 100.40, h: 100.405, l: 100.38, c: 100.39, v: 10 }); t += FIVE;
    out.push({ t, o: 100.39, h: 100.45, l: 100.385, c: 100.44, v: 10 });
    return [...pad, ...out];
  })();
  const nowMs = padded[padded.length - 1].t + FIVE + 5000;
  const crypto = { candles: async () => padded, hourly: async () => [], usdtInr: async () => ({ rate: 88, source: 'test' }) };
  const cfg = { ...EXHAUSTION_ONLY_DEFAULTS, min_rr: 100 }; // guaranteed skip -> shadow-tracked, not traded

  const bot1 = createExhaustionBot({ store, crypto, loadCfg: async () => cfg, shadowStore, now: () => nowMs, log: () => {} });
  await bot1.scan();
  assert.equal(shadowStore._db.rows.length, 3);

  // Restart: fresh bot instance, same stores, same candle.
  const bot2 = createExhaustionBot({ store, crypto, loadCfg: async () => cfg, shadowStore, now: () => nowMs, log: () => {} });
  await bot2.scan();
  assert.equal(shadowStore._db.rows.length, 3, 'still exactly 3 shadow rows, not 6 - the unique (bot, symbol, trigger_t) dedupe held across the restart');
  assert.equal(store._db.trades.length, 0, 'never a trade either way');
});
