'use strict';
// CC2 overnight item 3: exit accuracy against every candle's high/low since
// the last check, not only the latest tick price. Hand-worked candle walks.
const test = require('node:test');
const assert = require('node:assert/strict');
const { simulateExit } = require('../src/paper/lib/exitSim');

const k = (t, o, h, l, c) => ({ t, o, h, l, c, v: 1 });

test('long: target hit mid-walk books the exact target price, not the candle close', () => {
  // entry 100, target 110, stop 95. Candle 2's high (112) clears the target (110) even though it closes at 108.
  const r = simulateExit({
    entry: 100, target: 110, stop: 95, short: false, breakevenAt: 0.5,
    candles: [k(1, 101, 103, 99, 102), k(2, 102, 112, 101, 108)],
  });
  assert.deepEqual([r.exit, r.reason, r.price], [true, 'target', 110]);
});

test('short: stop hit books the stop price exactly (price can run further than the stop)', () => {
  // entry 100 short, target 90, stop 105. Candle's high 108 > stop 105: stop hit at 105, not 108.
  const r = simulateExit({ entry: 100, target: 90, stop: 105, short: true, candles: [k(1, 101, 108, 100, 107)] });
  assert.deepEqual([r.exit, r.reason, r.price], [true, 'stop', 105]);
});

test('both target and stop inside the same candle range: the stop is booked (cannot tell which came first)', () => {
  // long, entry 100, target 110, stop 95. One wide candle: low 93 (below stop), high 115 (above target).
  const r = simulateExit({ entry: 100, target: 110, stop: 95, short: false, candles: [k(1, 100, 115, 93, 105)] });
  assert.deepEqual([r.exit, r.reason, r.price, r.bothHitSameCandle], [true, 'stop', 95, true]);
});

test('breakeven moves the stop to the entry once the chosen fraction of the way to the target is covered, by the candle extreme not the close', () => {
  // long, entry 100, target 110, stop 95, breakevenAt 0.5 -> needs progress of 5 (half of 10).
  // Candle 1 high only reaches 104 (progress 4, not enough). Candle 2 high reaches 106 (progress 6 >= 5): breakeven.
  // Candle 3's low then dips to 100.5 - above the OLD stop 95 and above the NEW stop (entry) 100: no exit, breakeven already applied.
  const r = simulateExit({
    entry: 100, target: 110, stop: 95, short: false, breakevenAt: 0.5,
    candles: [k(1, 100, 104, 99, 101), k(2, 101, 106, 100, 103), k(3, 103, 104, 100.5, 101)],
  });
  assert.deepEqual([r.exit, r.breakevenDone, r.stopActive], [false, true, 100]);
});

test('breakeven then a pull-back through the entry: exits at breakeven_stop (not plain stop), at the entry price', () => {
  const r = simulateExit({
    entry: 100, target: 110, stop: 95, short: false, breakevenAt: 0.5,
    candles: [k(1, 100, 106, 99, 104), k(2, 104, 105, 99, 100)], // candle 2's low 99 crosses the new stop (100)
  });
  assert.deepEqual([r.exit, r.reason, r.price], [true, 'breakeven_stop', 100]);
});

test('breakeven already done before this walk starts: caller passes the ALREADY-MOVED stop (entry) and breakevenDone: true', () => {
  const r = simulateExit({ entry: 100, target: 110, stop: 100, short: false, breakevenDone: true, candles: [k(1, 101, 103, 99.5, 100)] });
  assert.deepEqual([r.exit, r.reason, r.price], [true, 'breakeven_stop', 100]);
});

test('no candles since the last check: holds, unchanged state', () => {
  const r = simulateExit({ entry: 100, target: 110, stop: 95, short: false, candles: [] });
  assert.deepEqual(r, { exit: false, action: 'hold', breakevenDone: false, stopActive: 95 });
});

test('neither level reached: holds', () => {
  const r = simulateExit({ entry: 100, target: 110, stop: 95, short: false, candles: [k(1, 100, 103, 97, 101)] });
  assert.deepEqual(r.exit, false);
  assert.equal(r.action, 'hold');
});
