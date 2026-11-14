'use strict';
// CC2 round 2 item 4: shadow tracking. A setup rejected for reward/risk is
// followed on paper to its own would-be stop/target, in its own table -
// never counted as a trade, never read by any entry/exit decision.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBot } = require('../paperbot/bot');
const { createMemoryStore } = require('../paperbot/store');
const S = require('./fixtures/cryptoScenario');

const k = (t, o, h, l, c) => ({ t, o, h, l, c, v: 100 });

function rig({ minRr = 5 } = {}) {
  // minRr: 5 forces the real exhaustion-reversal setup (reward/risk 3.28, docs/R-FACTOR.md style
  // numbers from test/paperCryptoLevels.test.js) to be REJECTED, while still leaving plan.target/stop
  // on the rejection (cryptoLevels.planTrade returns `plan` even when `ok` is false on this path).
  const candles = S.build();
  const clock = { t: S.scanTime(candles) };
  const store = createMemoryStore();
  const crypto = {
    candles: async (sym) => (sym === 'BTCUSDT' ? candles.filter((c) => c.t <= clock.t) : []),
    price: async () => 102.18,
    usdtInr: async () => ({ rate: 88, source: 'test' }),
  };
  const bot = createBot({ store, nse: null, crypto, now: () => clock.t, log: () => {} });
  const ready = store.setConfigIfMissing('crypto', { levels: { minRr } });
  return { candles, clock, store, bot, ready };
}

test('shadow: a reward/risk rejection with a real plan is followed on paper, never counted as a trade', async () => {
  const h = rig({ minRr: 5 });
  await h.ready;
  await h.bot.cryptoScan();
  assert.equal(h.store._db.trades.length, 0); // rejected, no trade
  assert.equal(h.store._db.shadows.length, 1);
  const sh = h.store._db.shadows[0];
  assert.deepEqual([sh.market, sh.symbol, sh.direction, sh.status, sh.entry_price, sh.target_price, sh.stop_price],
    ['crypto', 'BTCUSDT', 'down', 'open', 102.18, 99.099, 103.12]);
  assert.equal(sh.reason, 'reward/risk 3.28 is below 5 (target 99.099 before swing low 15m 99, stop 103.12)');
});

test('shadow: a rejection with NO plan (no level found at all) is not shadow-tracked - nothing to follow', async () => {
  const h = rig({ minRr: 0 });
  await h.ready;
  // dip: null removes the only support level, so planTrade fails before a plan is ever built
  const { build } = S;
  h.candles.length = 0;
  h.candles.push(...build({ dip: null }));
  await h.bot.cryptoScan();
  assert.equal(h.store._db.shadows.length, 0);
});

test('shadow: hits its target - closed outcome target, pnl% matches the real-trade math, never touches paper_trades', async () => {
  const h = rig({ minRr: 5 });
  await h.ready;
  await h.bot.cryptoScan();
  const id = h.store._db.shadows[0].id;
  // walk the price down to the target (99.099) with one closed candle, same mechanism as the real monitor
  h.candles.push(k(h.clock.t, 102.18, 102.18, 99, 99));
  h.clock.t += S.FIVE + 25000;
  await h.bot.shadowMonitor();
  const sh = h.store._db.shadows.find((x) => x.id === id);
  assert.deepEqual([sh.status, sh.outcome], ['closed', 'target']);
  // short: (102.18 - 99.099) / 102.18 x 100 = 3.01527% -> rounds to 3.02
  assert.equal(sh.result_pct, 3.02);
  assert.equal(h.store._db.trades.length, 0); // still never a trade
});

test('shadow: hits its stop - closed outcome stop, negative pnl%', async () => {
  const h = rig({ minRr: 5 });
  await h.ready;
  await h.bot.cryptoScan();
  const id = h.store._db.shadows[0].id;
  h.candles.push(k(h.clock.t, 102.18, 103.3, 102.18, 103.2));
  h.clock.t += S.FIVE + 25000;
  await h.bot.shadowMonitor();
  const sh = h.store._db.shadows.find((x) => x.id === id);
  assert.deepEqual([sh.status, sh.outcome], ['closed', 'stop']);
  // booked at the stop level (103.12), not the overshoot 103.2 or 103.3: -(103.12-102.18)/102.18 x 100 = -0.9195%
  assert.equal(sh.result_pct, -0.92);
});

test('shadow: no new candle yet -> stays open, checked again next time', async () => {
  const h = rig({ minRr: 5 });
  await h.ready;
  await h.bot.cryptoScan();
  const r = await h.bot.shadowMonitor();
  assert.deepEqual([r.checked, r.closed], [1, 0]);
  assert.equal(h.store._db.shadows[0].status, 'open');
});
