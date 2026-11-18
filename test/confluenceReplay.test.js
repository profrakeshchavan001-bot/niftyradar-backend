'use strict';
// GROUP 5: pure helpers of scripts/confluenceReplay.js (the chronological 60/40 split and the summary
// shape) - no database needed. The full replay itself needs PAPER_DATABASE_URL (real stored candle
// history) and is exercised manually, same convention as scripts/filterStrictnessReport.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitCandles, summarise } = require('../scripts/confluenceReplay');

const MIN = 60000;

test('splitCandles: 60/40 split is by TIME, decided before any trade is simulated', () => {
  const candles = Array.from({ length: 100 }, (_, i) => ({ t: i * MIN, o: 1, h: 1, l: 1, c: 1 }));
  const { train, test: testSet, cutoffT } = splitCandles(candles);
  assert.equal(cutoffT, 0 + (99 * MIN) * 0.6);
  assert.ok(train.every((k) => k.t <= cutoffT));
  assert.ok(testSet.every((k) => k.t > cutoffT));
  assert.equal(train.length + testSet.length, 100);
});

test('splitCandles: empty input is handled without throwing', () => {
  assert.deepEqual(splitCandles([]), { train: [], test: [], cutoffT: null });
});

test('summarise: fewer than MIN_TRADES is honestly reported as tooFew, never a fabricated win rate', () => {
  const s = summarise([]);
  assert.equal(s.tooFew, true);
  assert.equal(s.winRatePct, null);
});

test('summarise: average R:R is computed only from trades with a real stored rr', () => {
  const trades = [
    { entry_t: 1, symbol: 'BTCUSDT', hour_utc: 1, pnl_inr: 10, rr: 2 },
    { entry_t: 2, symbol: 'BTCUSDT', hour_utc: 1, pnl_inr: -5, rr: 1.5 },
    { entry_t: 3, symbol: 'BTCUSDT', hour_utc: 1, pnl_inr: 10, rr: null },
  ];
  const s = summarise(trades);
  assert.equal(s.avgRr, 1.75);
});
