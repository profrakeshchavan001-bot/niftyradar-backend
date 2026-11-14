'use strict';
// CC2 round 2 item 2: SMC/ICT detectors (src/paper/lib/smc/). One hand-worked
// test per detector, plus the combined tagSmc() wiring.
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyStructureBreak } = require('../src/paper/lib/smc/structure');
const { equalHighsLows } = require('../src/paper/lib/smc/liquidity');
const { classifyPremiumDiscount } = require('../src/paper/lib/smc/premiumDiscount');
const { isDisplacement } = require('../src/paper/lib/smc/displacement');
const { cryptoSession, nseDaySession } = require('../src/paper/lib/smc/sessions');
const { tagSmc } = require('../src/paper/lib/smc');

const k = (t, o, h, l, c) => ({ t, o, h, l, c, v: 1 });

// ---- structure (BOS / CHoCH) -------------------------------------------------
// 7 "prior" candles: closes [10,10.3,10.1,10.6,11,11.4,11.8] -> uptrend (hand-worked
// EMA3: seed avg(10,10.3,10.1)=10.1333, ema steps 10.3667, 10.6833, 11.0417, 11.4208;
// last close 11.8 > ema-now 11.4208 > ema-before 11.0417 -> 'up'). lows [9.0,9.2,8.0,
// 9.3,9.5,9.6,9.7]: only idx2 (8.0) is a swing low (< both neighbours, k=1). highs
// [10.5,10.8,11.5,11.0,11.3,11.6,12.0]: only idx2 (11.5) is a swing high.
const PRIOR = [
  k(0, 9.8, 10.5, 9.0, 10), k(1, 10, 10.8, 9.2, 10.3), k(2, 10.3, 11.5, 8.0, 10.1), k(3, 10.1, 11.0, 9.3, 10.6),
  k(4, 10.6, 11.3, 9.5, 11), k(5, 11, 11.6, 9.6, 11.4), k(6, 11.4, 12.0, 9.7, 11.8),
];
const STRUCT_OPT = { trendN: 3, swingK: 1, swingLookback: 10 };

test('structure: BOS up - prior trend up, last candle closes above the most recent swing high (11.5)', () => {
  const r = classifyStructureBreak([...PRIOR, k(7, 12, 13, 11.8, 12.5)], STRUCT_OPT);
  assert.deepEqual(r, { type: 'bos', direction: 'up', level: 11.5 });
});

test('structure: CHoCH down - prior trend up, last candle closes below the most recent swing low (8.0) - a reversal, not a continuation', () => {
  const r = classifyStructureBreak([...PRIOR, k(7, 8.3, 8.4, 7.0, 7.5)], STRUCT_OPT);
  assert.deepEqual(r, { type: 'choch', direction: 'down', level: 8.0 });
});

test('structure: no break when the close stays inside the last swing high/low', () => {
  const r = classifyStructureBreak([...PRIOR, k(7, 11.1, 11.2, 10.5, 11.0)], STRUCT_OPT);
  assert.deepEqual(r, { type: null, direction: null });
});

test('structure: not enough candles -> null, never guessed', () => {
  assert.equal(classifyStructureBreak(PRIOR.slice(0, 3), STRUCT_OPT), null);
});

// ---- liquidity pools (equal highs/lows) --------------------------------------
test('liquidity: three highs within 0.05% cluster into one pool; lows with no cluster give none', () => {
  const candles = [
    k(0, 99.9, 100, 90, 95), k(1, 99.9, 100.02, 91, 95), k(2, 99.9, 100.01, 92, 95), k(3, 104, 105, 93, 104), k(4, 109, 110, 94, 109),
  ];
  const r = equalHighsLows(candles);
  // avg(100, 100.01, 100.02) = 100.01
  assert.deepEqual(r, { equalHighs: [{ price: 100.01, touches: 3 }], equalLows: [] });
});

// ---- premium / discount -------------------------------------------------------
// Range from 4 candles: high 200 (candle 0), low 100 (candle 1) -> mid 150.
const PD_BASE = [k(0, 190, 200, 150, 190), k(1, 140, 180, 100, 140), k(2, 150, 170, 120, 150), k(3, 155, 160, 130, 155)];

test('premium/discount: close 180 -> premium, pct = (180-100)/100 = 0.8', () => {
  const r = classifyPremiumDiscount([...PD_BASE, k(4, 180, 185, 175, 180)], 5);
  assert.deepEqual(r, { zone: 'premium', pct: 0.8, rangeHigh: 200, rangeLow: 100, mid: 150 });
});

test('premium/discount: close 120 -> discount, pct = (120-100)/100 = 0.2', () => {
  const r = classifyPremiumDiscount([...PD_BASE, k(4, 120, 125, 115, 120)], 5);
  assert.deepEqual(r, { zone: 'discount', pct: 0.2, rangeHigh: 200, rangeLow: 100, mid: 150 });
});

test('premium/discount: close exactly at the midpoint (150) -> equilibrium, pct 0.5', () => {
  const r = classifyPremiumDiscount([...PD_BASE, k(4, 150, 155, 145, 150)], 5);
  assert.deepEqual(r, { zone: 'equilibrium', pct: 0.5, rangeHigh: 200, rangeLow: 100, mid: 150 });
});

test('premium/discount: a flat range (high == low) -> null, never a divide-by-zero guess', () => {
  assert.equal(classifyPremiumDiscount([k(0, 100, 100, 100, 100)], 5), null);
});

// ---- displacement --------------------------------------------------------------
const DISP_PRIOR = [k(0, 10, 11.2, 9.8, 11), k(1, 10, 11.2, 9.8, 11), k(2, 10, 11.2, 9.8, 11), k(3, 10, 11.2, 9.8, 11), k(4, 10, 11.2, 9.8, 11)]; // body 1 each, avg body 1

test('displacement: body 3x the average of the prior 5 (>= the 2x default) -> displaced', () => {
  const r = isDisplacement([...DISP_PRIOR, k(5, 20, 23.5, 19.5, 23)], { look: 5 });
  assert.deepEqual(r, { displaced: true, bodyRatio: 3, direction: 'up' });
});

test('displacement: body 1.5x the average (below the 2x default) -> not displaced', () => {
  const r = isDisplacement([...DISP_PRIOR, k(5, 20, 22, 19.4, 21.5)], { look: 5 });
  assert.deepEqual(r, { displaced: false, bodyRatio: 1.5, direction: 'up' });
});

test('displacement: not enough candles -> null', () => {
  assert.equal(isDisplacement(DISP_PRIOR.slice(0, 3), { look: 5 }), null);
});

// ---- sessions --------------------------------------------------------------------
test('cryptoSession: UTC-hour bands', () => {
  const h = (hr) => Date.UTC(2026, 10, 16, hr, 0, 0);
  assert.deepEqual([cryptoSession(h(0)), cryptoSession(h(7)), cryptoSession(h(8)), cryptoSession(h(12)), cryptoSession(h(13)), cryptoSession(h(20)), cryptoSession(h(21)), cryptoSession(h(23))],
    ['asia', 'asia', 'london', 'london', 'new_york', 'new_york', 'after_hours', 'after_hours']);
});

test('nseDaySession: open drive, mid-session, lunch, close and closed, at the exact IST minute boundaries', () => {
  const u = (h, m) => Date.UTC(2026, 10, 16, h, m, 0); // UTC = IST - 05:30
  assert.equal(nseDaySession(u(3, 44)), 'closed'); // 09:14 IST
  assert.equal(nseDaySession(u(3, 45)), 'open_drive'); // 09:15 IST
  assert.equal(nseDaySession(u(4, 14)), 'open_drive'); // 09:44 IST
  assert.equal(nseDaySession(u(4, 15)), 'mid_session'); // 09:45 IST
  assert.equal(nseDaySession(u(6, 29)), 'mid_session'); // 11:59 IST
  assert.equal(nseDaySession(u(6, 30)), 'lunch'); // 12:00 IST
  assert.equal(nseDaySession(u(7, 29)), 'lunch'); // 12:59 IST
  assert.equal(nseDaySession(u(7, 30)), 'mid_session'); // 13:00 IST
  assert.equal(nseDaySession(u(9, 29)), 'mid_session'); // 14:59 IST
  assert.equal(nseDaySession(u(9, 30)), 'close'); // 15:00 IST
  assert.equal(nseDaySession(u(10, 0)), 'close'); // 15:30 IST
  assert.equal(nseDaySession(u(10, 1)), 'closed'); // 15:31 IST
});

// ---- combined tagSmc() wiring (not a hand-worked value test - proves it never throws and returns strings) ----
test('tagSmc: runs every detector without throwing, even on too-short input, and returns a tag list', () => {
  const emptyNow = Date.UTC(2026, 10, 16, 14, 0, 0); // 14:00 UTC -> new_york
  assert.deepEqual(tagSmc({ c5: [], nowMs: emptyNow, market: 'crypto' }), ['session_new_york']);
  // (structure needs 22+ candles at the default trendN=20, so this short fixture never produces a bos/choch
  // tag - that is covered on its own, with a smaller trendN override, in the "structure:" tests above.)
  const tags = tagSmc({ c5: [...PRIOR, k(7, 12, 13, 11.8, 12.5)], nowMs: Date.UTC(2026, 10, 16, 3, 45, 0), market: 'nse' });
  assert.ok(Array.isArray(tags) && tags.every((t) => typeof t === 'string'));
  assert.ok(tags.includes('session_open_drive'));
});
