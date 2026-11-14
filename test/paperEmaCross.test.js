'use strict';
// CC2 overnight item 5: EMA crossover confirmation/warning (src/paper/lib/emaCross.js).
// All EMA values below are hand-worked (see the comments) using fastN=2, slowN=3
// so the arithmetic stays checkable; the production call site uses the real
// EMA9/21 (5m) and EMA20/50 (15m/1h) periods from the brief, which does not
// change the combining logic this file tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { emaCrossState, classifyEmaCross } = require('../src/paper/lib/emaCross');
const { createBot } = require('../paperbot/bot');
const { createMemoryStore } = require('../paperbot/store');
const S = require('./fixtures/cryptoScenario');

const closesToCandles = (closes) => closes.map((c, i) => ({ t: i, o: c, h: c, l: c, c, v: 1 }));

// closes [10,8,6,4,2,10], fastN=2 (k=2/3), slowN=3 (k=0.5):
//   fastNow  = ema([10,8,6,4,2,10],2): seed avg(10,8)=9 -> 7 -> 5 -> 3 -> 7.6667
//   fastPrev = ema([10,8,6,4,2],2):    seed 9 -> 7 -> 5 -> 3
//   slowNow  = ema([10,8,6,4,2,10],3): seed avg(10,8,6)=8 -> 6 -> 4 -> 7
//   slowPrev = ema([10,8,6,4,2],3):    seed 8 -> 6 -> 4
// now: fast 7.6667 > slow 7 -> 'up'; prev: fast 3 < slow 4 -> 'down' -> fresh cross up
const FRESH_UP = closesToCandles([10, 8, 6, 4, 2, 10]);

// closes [1,2,3,4,5,6], fastN=2, slowN=3:
//   fastNow = ema(...,2) = 5.5, fastPrev = ema([1,2,3,4,5],2) = 4.5
//   slowNow = ema(...,3) = 5,   slowPrev = ema([1,2,3,4,5],3) = 4
// now: 5.5 > 5 -> 'up'; prev: 4.5 > 4 -> 'up' too -> confirmed, not fresh
const CONFIRMED_UP = closesToCandles([1, 2, 3, 4, 5, 6]);

// mirror of CONFIRMED_UP: confirmed 'down', not fresh (worked out the same way, flipped)
const CONFIRMED_DOWN = closesToCandles([6, 5, 4, 3, 2, 1]);

test('emaCrossState: fresh cross up (hand-worked)', () => {
  const s = emaCrossState(FRESH_UP, 2, 3);
  assert.equal(s.side, 'up');
  assert.equal(s.fresh, true);
  assert.ok(Math.abs(s.fast - 7.6667) < 0.001 && Math.abs(s.slow - 7) < 0.001);
});

test('emaCrossState: same side as the candle before -> not fresh', () => {
  const s = emaCrossState(CONFIRMED_UP, 2, 3);
  assert.deepEqual([s.side, s.fresh], ['up', false]);
});

test('emaCrossState: not enough candles -> null, never guessed', () => {
  assert.equal(emaCrossState(closesToCandles([1, 2, 3]), 2, 3), null);
});

test('classifyEmaCross: unknown when the 5-min timeframe has too few candles', () => {
  assert.equal(classifyEmaCross({ direction: 'up', c5: closesToCandles([1, 2, 3]), fast5: 2, slow5: 3 }), 'unknown');
});

test('classifyEmaCross: a fresh 5-min cross WITH the trade direction is a strong confirmation', () => {
  assert.equal(classifyEmaCross({ direction: 'up', c5: FRESH_UP, fast5: 2, slow5: 3 }), 'fresh_with');
});

test('classifyEmaCross: a fresh 5-min cross AGAINST the trade direction is a warning, never a block', () => {
  assert.equal(classifyEmaCross({ direction: 'down', c5: FRESH_UP, fast5: 2, slow5: 3 }), 'fresh_against');
});

test('classifyEmaCross: no fresh cross, only the 5-min timeframe available, agrees -> confirmed_with', () => {
  assert.equal(classifyEmaCross({ direction: 'up', c5: CONFIRMED_UP, fast5: 2, slow5: 3 }), 'confirmed_with');
});

test('classifyEmaCross: no fresh cross, only the 5-min timeframe available, disagrees -> confirmed_against', () => {
  assert.equal(classifyEmaCross({ direction: 'down', c5: CONFIRMED_UP, fast5: 2, slow5: 3 }), 'confirmed_against');
});

test('classifyEmaCross: 5-min and 15-min split evenly (one with, one against) -> mixed', () => {
  const label = classifyEmaCross({
    direction: 'up', c5: CONFIRMED_UP, c15: CONFIRMED_DOWN, fast5: 2, slow5: 3, fast15: 2, slow15: 3,
  });
  assert.equal(label, 'mixed');
});

test('classifyEmaCross: a missing timeframe (no 1-hour feed) never blocks an answer', () => {
  const label = classifyEmaCross({ direction: 'up', c5: CONFIRMED_UP, c15: null, c1h: null, fast5: 2, slow5: 3 });
  assert.equal(label, 'confirmed_with');
});

// Wiring check, not a hand-worked value: the real crypto scan (90+ candles) stores SOME valid
// ema_cross label on the trade row, using the production EMA9/21 / EMA20/50 periods. The pure
// function's own arithmetic is already hand-verified above; this only proves bot.js is wired up.
test('bot: cryptoScan stores a valid ema_cross label on the trade it opens', async () => {
  const candles = S.build();
  const store = createMemoryStore();
  const crypto = { candles: async (s) => (s === 'BTCUSDT' ? candles : []), price: async () => 102.18, usdtInr: async () => ({ rate: 88, source: 'test' }) };
  const bot = createBot({ store, nse: null, crypto, now: () => S.scanTime(candles) });
  await bot.cryptoScan();
  const t = store._db.trades[0];
  assert.ok(t, 'a trade was opened');
  assert.ok(['fresh_with', 'fresh_against', 'fresh_flat', 'confirmed_with', 'confirmed_against', 'mixed', 'unknown'].includes(t.ema_cross), `unexpected ema_cross label: ${t.ema_cross}`);
});
