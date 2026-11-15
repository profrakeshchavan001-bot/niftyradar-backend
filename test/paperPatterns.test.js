'use strict';
// Paper bot: pattern detection and indicators. Expected values are worked out
// by hand in the comments, not copied from the code's output.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../paperbot/patterns');

// rows of [open, high, low, close, volume]
const mk = (rows) => rows.map(([o, h, l, c, v], i) => ({ t: i * 300000, o, h, l, c, v: v ?? 100 }));

test('ema: seed = average of first n, then k = 2/(n+1)', () => {
  // seed (1+2+3)/3 = 2; k = 0.5; 4 -> 3; 5 -> 4
  assert.equal(P.ema([1, 2, 3, 4, 5], 3), 4);
  assert.equal(P.ema([1, 2], 3), null);
});

test('vwap: typical price weighted by volume', () => {
  // tp 9 x 100 + tp 11 x 300 = 4200 / 400 = 10.5
  assert.equal(P.vwap(mk([[9, 10, 8, 9, 100], [11, 12, 10, 11, 300]])), 10.5);
});

test('trendOf: needs n+1 candles, otherwise unknown', () => {
  const up = mk(Array.from({ length: 25 }, (_, i) => [100 + i, 101.2 + i, 99.8 + i, 101 + i]));
  assert.equal(P.trendOf(up, 20), 'up');
  assert.equal(P.trendOf([...up].reverse().map((k, i) => ({ ...k, t: i })), 20), 'down');
  assert.equal(P.trendOf(up.slice(0, 20), 20), 'unknown');
});

// Fall: 5 red + 1 green, bodies 2,2,1,2,2,2 -> average 11/6 = 1.83, so a
// "small" body is at most 0.92. Small red body 0.5, high 101.2.
const fall = [[110, 110.2, 107.8, 108], [108, 108.2, 105.8, 106], [106, 107.2, 105.8, 107], [107, 107.2, 104.8, 105], [105, 105.2, 102.8, 103], [103, 103.2, 100.8, 101]];
const smallRed = [101, 101.2, 100.2, 100.5];

test('exhaustion reversal up: fall, small red, green close above its high', () => {
  const r = P.exhaustionReversal(mk([...fall, smallRed, [100.6, 102, 100.5, 101.8]]), { vwap: 104 });
  assert.equal(r.name, 'exhaustion_reversal');
  assert.equal(r.direction, 'up');
  assert.equal(r.kind, 'reversal');
  assert.deepEqual(r.candles.map((k) => [k.o, k.h, k.l, k.c]), [[101, 101.2, 100.2, 100.5], [100.6, 102, 100.5, 101.8]]);
});

test('exhaustion reversal: no signal when a condition is missing', () => {
  // green candle closes at 101.1, not above the small candle high 101.2
  assert.equal(P.exhaustionReversal(mk([...fall, smallRed, [100.6, 101.15, 100.5, 101.1]]), { vwap: 104 }), null);
  // price is above VWAP (100), so it is not a "below VWAP" downtrend
  assert.equal(P.exhaustionReversal(mk([...fall, smallRed, [100.6, 102, 100.5, 101.8]]), { vwap: 100 }), null);
  // the red candle is not small: body 1.5 > 0.92
  assert.equal(P.exhaustionReversal(mk([...fall, [101, 101.2, 99.3, 99.5], [99.6, 102, 99.5, 101.8]]), { vwap: 104 }), null);
  // only 3 of 6 red
  const weak = [[110, 111.2, 109.8, 111], [111, 112.2, 110.8, 112], [112, 113.2, 111.8, 113], ...fall.slice(3)];
  assert.equal(P.exhaustionReversal(mk([...weak, smallRed, [100.6, 102, 100.5, 101.8]]), { vwap: 120 }), null);
  // no VWAP known: never guess
  assert.equal(P.exhaustionReversal(mk([...fall, smallRed, [100.6, 102, 100.5, 101.8]]), {}), null);
});

test('exhaustion reversal down: rise, small green, red close below its low', () => {
  const rise = [[100, 102.2, 99.8, 102], [102, 104.2, 101.8, 104], [104, 104.2, 102.8, 103], [103, 105.2, 102.8, 105], [105, 107.2, 104.8, 107], [107, 109.2, 106.8, 109]];
  const r = P.exhaustionReversal(mk([...rise, [109, 109.8, 108.8, 109.5], [109.4, 109.5, 108, 108.2]]), { vwap: 105 });
  assert.equal(r.direction, 'down');
});

// NSE-only variant (docs/PAPER-BOT.md, paperbot/bot.js analyse() with `variant: 'nse'`): the owner's rule
// needs a SECOND confirming candle before entry fires - the first green candle closing above the small
// candle's high is only the start of the reversal, not itself a signal.
const confirm1 = [100.6, 101.3, 100.5, 101.25]; // first green: closes 101.25, above the small candle's high 101.2 - not a signal by itself
test('exhaustion reversal (NSE, confirmed): fall, small red, first green above its high (no signal yet), second green above the first green\'s high (signal)', () => {
  assert.equal(P.exhaustionReversalConfirmed(mk([...fall, smallRed, confirm1]), { vwap: 104 }), null, 'only one green candle so far: not yet confirmed');
  const r = P.exhaustionReversalConfirmed(mk([...fall, smallRed, confirm1, [101.25, 102, 101.2, 101.8]]), { vwap: 104 });
  assert.equal(r.name, 'exhaustion_reversal');
  assert.equal(r.direction, 'up');
  assert.equal(r.kind, 'reversal');
  assert.deepEqual(r.candles.map((k) => [k.o, k.h, k.l, k.c]), [[101, 101.2, 100.2, 100.5], [100.6, 101.3, 100.5, 101.25], [101.25, 102, 101.2, 101.8]]);
  assert.match(r.note, /confirmed by a second green close/);
});

test('exhaustion reversal (NSE, confirmed): no signal when the second candle does not confirm', () => {
  // second candle is green but closes AT the first green's high, not above it
  assert.equal(P.exhaustionReversalConfirmed(mk([...fall, smallRed, confirm1, [101.25, 101.3, 101.2, 101.3]]), { vwap: 104 }), null);
  // second candle is red (the reversal stalled)
  assert.equal(P.exhaustionReversalConfirmed(mk([...fall, smallRed, confirm1, [101.25, 101.3, 100.9, 101]]), { vwap: 104 }), null);
  // the original single-candle rule still fires on exactly this shape (unchanged, still used by every crypto bot)
  assert.equal(P.exhaustionReversal(mk([...fall, smallRed, confirm1]), { vwap: 104 }).direction, 'up');
});

test('exhaustion reversal (NSE, confirmed) down: mirror of the up case', () => {
  const rise = [[100, 102.2, 99.8, 102], [102, 104.2, 101.8, 104], [104, 104.2, 102.8, 103], [103, 105.2, 102.8, 105], [105, 107.2, 104.8, 107], [107, 109.2, 106.8, 109]];
  const small = [109, 109.8, 108.8, 109.5];
  const firstRed = [109.4, 109.45, 108.6, 108.7]; // closes 108.7, below the small candle's low 108.8 - not a signal by itself
  assert.equal(P.exhaustionReversalConfirmed(mk([...rise, small, firstRed]), { vwap: 105 }), null, 'only one red candle so far');
  const r = P.exhaustionReversalConfirmed(mk([...rise, small, firstRed, [108.7, 108.75, 108, 108.2]]), { vwap: 105 });
  assert.equal(r.direction, 'down');
});

test('detectPatterns: variant "nse" uses the confirmed rule, the default variant (every other caller) does not', () => {
  const twoGreens = mk([...fall, smallRed, confirm1, [101.25, 102, 101.2, 101.8]]);
  const oneGreen = mk([...fall, smallRed, confirm1]);
  assert.ok(P.detectPatterns(twoGreens, { vwap: 104 }, {}, 'nse').some((p) => p.name === 'exhaustion_reversal'));
  assert.ok(!P.detectPatterns(oneGreen, { vwap: 104 }, {}, 'nse').some((p) => p.name === 'exhaustion_reversal'), 'nse: one green candle is not enough');
  assert.ok(P.detectPatterns(oneGreen, { vwap: 104 }).some((p) => p.name === 'exhaustion_reversal'), 'default variant (crypto): the single-candle rule still fires, unchanged');
});

test('engulfing: bullish and bearish', () => {
  assert.equal(P.engulfing(mk([[100, 100.2, 98.8, 99], [98.9, 100.6, 98.8, 100.5]])).name, 'bullish_engulfing');
  assert.equal(P.engulfing(mk([[99, 100.2, 98.8, 100], [100.1, 100.2, 98.4, 98.5]])).name, 'bearish_engulfing');
  // second body (99.2-99.8) does not cover the first (100-99)
  assert.equal(P.engulfing(mk([[100, 100.2, 98.8, 99], [99.2, 99.9, 99.1, 99.8]])), null);
});

test('hammer: lower wick 2 = 4x body 0.5, upper wick 0.1, after a fall', () => {
  const pre = [[106, 106.2, 104.8, 105], [105, 105.2, 102.8, 103], [103, 103.2, 100.8, 101]];
  const r = P.hammer(mk([...pre, [100, 100.6, 98, 100.5]]));
  assert.equal(r.name, 'hammer');
  assert.equal(r.direction, 'up');
  // same candle after a rise (close 3 candles back was 95) is not a hammer signal
  assert.equal(P.hammer(mk([[94, 95.2, 93.8, 95], [95, 97.2, 94.8, 97], [97, 99.2, 96.8, 99], [100, 100.6, 98, 100.5]])), null);
});

test('shooting star: upper wick 2 = 4x body 0.5, after a rise', () => {
  const pre = [[94, 95.2, 93.8, 95], [95, 97.2, 94.8, 97], [97, 99.2, 96.8, 99]];
  const r = P.shootingStar(mk([...pre, [100.5, 102.5, 99.9, 100]]));
  assert.equal(r.name, 'shooting_star');
  assert.equal(r.direction, 'down');
});

test('morning star and evening star', () => {
  // red 105->100 (midpoint 102.5), small candle below it, green close 103 > 102.5
  assert.equal(P.star(mk([[105, 105.2, 99.8, 100], [99.5, 99.9, 99.4, 99.8], [100, 103.2, 99.9, 103]])).name, 'morning_star');
  // green 100->105 (midpoint 102.5), small candle above it, red close 102 < 102.5
  assert.equal(P.star(mk([[100, 105.2, 99.8, 105], [105.5, 105.9, 105.4, 105.7], [105, 105.1, 101.8, 102]])).name, 'evening_star');
  // green close 102 does not pass the midpoint 102.5
  assert.equal(P.star(mk([[105, 105.2, 99.8, 100], [99.5, 99.9, 99.4, 99.8], [100, 102.2, 99.9, 102]])), null);
});

test('inside-bar breakout: close beyond the mother candle', () => {
  const mother = [104, 110, 100, 106];
  const inside = [105, 108, 102, 106];
  assert.equal(P.insideBarBreakout(mk([mother, inside, [106, 111.5, 105.5, 111]])).direction, 'up');
  assert.equal(P.insideBarBreakout(mk([mother, inside, [106, 106.5, 98.5, 99]])).direction, 'down');
  assert.equal(P.insideBarBreakout(mk([mother, inside, [106, 109.5, 105.5, 109]])), null); // still inside
  assert.equal(P.insideBarBreakout(mk([mother, [105, 111, 102, 106], [106, 112, 105.5, 111.5]])), null); // not an inside bar
});

test('liquidity sweep: wick takes the swing low/high, close comes back inside', () => {
  const base = Array.from({ length: 10 }, (_, i) => [104, 110 - (i % 3), 100 + (i % 3), 105]); // lowest low 100, highest high 110
  const up = P.liquiditySweep(mk([...base, [102, 103, 99.5, 101]]));
  assert.equal(up.direction, 'up');
  assert.match(up.note, /swing low 100/);
  assert.equal(P.liquiditySweep(mk([...base, [108, 110.5, 107, 109]])).direction, 'down');
  assert.equal(P.liquiditySweep(mk([...base, [102, 103, 99.5, 99.8]])), null); // closed below the low: a breakdown, not a sweep
});

test('order block: retest of the last red candle before an impulsive up move', () => {
  const rows = [
    [100, 101.2, 99.8, 101], [101, 101.2, 99.8, 100], [100, 101.2, 99.8, 101], [101, 101.2, 99.8, 100], [100, 101.2, 99.8, 101],
    [101, 101.2, 99.8, 100], // order block: red, zone 99.8-101.2 (bodies before the impulse are all 1)
    [100, 104.2, 100, 104], // impulse: body 4 >= 2 x 1
    [104, 105.2, 103.8, 105],
    [101.5, 102.6, 101, 102.5], // dips to 101 (inside the zone), closes 102.5 above 101.2
  ];
  const r = P.orderBlock(mk(rows));
  assert.equal(r.name, 'order_block');
  assert.equal(r.direction, 'up');
  rows[8] = [103.5, 104.6, 103, 104.5]; // never reaches the zone
  assert.equal(P.orderBlock(mk(rows)), null);
});

test('fair value gap retest', () => {
  const rows = [
    [100, 100.8, 99.8, 100.5],
    [100.5, 101, 100.3, 100.9], // high 101 = gap bottom
    [101, 103.6, 100.9, 103.5],
    [103.5, 104.5, 103, 104.2], // low 103 = gap top
    [103.8, 104.2, 102.5, 104], // dips to 102.5 inside 101-103, closes 104
  ];
  const r = P.fvgRetest(mk(rows));
  assert.equal(r.name, 'fvg_retest');
  assert.equal(r.direction, 'up');
  assert.match(r.note, /gap 101-103/);
  rows[4] = [103.8, 104.2, 103.4, 104]; // stays above the gap
  assert.equal(P.fvgRetest(mk(rows)), null);
  rows[4] = [103.8, 104.2, 100.5, 104]; // goes right through the gap bottom
  assert.equal(P.fvgRetest(mk(rows)), null);
});

test('detectPatterns: flat identical candles fire nothing', () => {
  const flat = mk(Array.from({ length: 30 }, () => [100, 100.5, 99.5, 100.2]));
  assert.deepEqual(P.detectPatterns(flat, { vwap: 100 }), []);
});
