'use strict';
// Group 2 (2026-11): an NSE trade is taken ONLY on a real Dhan option-chain price - never a
// simulated/Yahoo-derived premium. Focused, fixture-light tests on top of the real createBot()/nseScan()
// (test/paperReplay.test.js covers the same fix against the bigger hand-built replay fixture; this file
// isolates just the real-price-required behaviour with a minimal rig).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBot } = require('../paperbot/bot');
const { createMemoryStore } = require('../paperbot/store');

const MIN = 60000;
const FIVE = 5 * MIN;
// The same hand-built exhaustion-reversal fixture test/paperReplay.test.js already relies on (entry on
// the second confirming green candle) - reused here rather than a second hand-built candle set, so this
// file can focus purely on the real-option-price behaviour.
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'paper_replay.json'), 'utf8'));

function rig({ optionQuote }) {
  const closedAt = (atMs) => fx.nse.candles.filter((k) => k.t + FIVE <= atMs);
  const clock = { t: fx.nse.sessionStart };
  const store = createMemoryStore();
  const logs = [];
  const nse = {
    ranking: () => {
      const last = closedAt(clock.t).at(-1);
      if (!last) return null;
      return [{ symbol: 'TESTSTK', price: last.c, pct: -1.8, volume: 50000000 }];
    },
    candles: async () => ({ candles: fx.nse.candles.filter((k) => k.t <= clock.t), source: 'test_fixture', dataSource: 'dhan' }),
    spot: () => closedAt(clock.t).at(-1)?.c ?? null,
    optionQuote,
    lotSize: () => 500,
    news: async () => [],
  };
  const bot = createBot({ store, nse, crypto: null, now: () => clock.t, log: (m) => logs.push(m) });
  async function scanToEntry() {
    // Same minute-by-minute cadence test/paperReplay.test.js's nseHarness uses: scan 20s after every
    // 5-minute mark until a trade or skip for the signal appears.
    for (let m = 0; m <= 150; m++) {
      clock.t = fx.nse.sessionStart + m * MIN + 20000;
      if (m % 5 === 0) await bot.nseScan();
      if (store._db.trades.length || store._db.skips.some((s) => s.reason === 'no real option price')) return;
    }
  }
  return { bot, store, logs, clock, scanToEntry };
}

test('real Dhan option price available: trade is taken, price_source "dhan_option_chain_ltp", simulated_option false', async () => {
  const h = rig({ optionQuote: async (symbol, dir, fixed) => ({ ltp: 20, strike: fixed?.strike ?? 490, expiry: fixed?.expiry ?? '2026-11-26', spot: 492 }) });
  await h.scanToEntry();
  assert.equal(h.store._db.trades.length, 1);
  const t = h.store._db.trades[0];
  assert.equal(t.simulated_option, false);
  assert.equal(t.price_source, 'dhan_option_chain_ltp');
  assert.equal(t.entry_price, 20);
  assert.equal(t.instrument, 'TESTSTK 2026-11-26 490 CE');
});

test('no real option price available: entry skipped, reason "no real option price", never a simulated premium', async () => {
  const h = rig({ optionQuote: async () => null });
  await h.scanToEntry();
  assert.equal(h.store._db.trades.length, 0, 'never a trade on a simulated/guessed premium');
  const skip = h.store._db.skips.find((s) => s.symbol === 'TESTSTK' && s.reason === 'no real option price');
  assert.ok(skip, 'expected a skip row with reason "no real option price"');
  assert.ok(skip.patterns.includes('exhaustion_reversal'));
});

test('a stale/zero option price also counts as "not available" (nse.optionQuote already returns null for those) - still skipped, never simulated', async () => {
  // nse.optionQuote (paperbot/sources.js) is itself responsible for returning null on a zero/stale/
  // missing LTP - this confirms the bot's OWN side of the contract: whatever optionQuote decides is "no
  // real price" (represented here as null, same as a zero/stale price would resolve to), the bot skips
  // rather than ever falling back to a guessed premium.
  const h = rig({ optionQuote: async () => null });
  await h.scanToEntry();
  assert.equal(h.store._db.trades.length, 0);
});
