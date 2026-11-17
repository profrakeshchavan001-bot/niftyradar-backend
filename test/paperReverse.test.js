'use strict';
// REVERSE trades (requested alongside MIRROR): same entry price/time/qty as the original, SAME direction
// as the MIRROR (opposite of the original), but with proper 2:1 reward:risk levels of its own instead of
// the mirror's swapped, ~0.3 reward:risk ones - src/paper/lib/reverse.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReverseEntry, estimateReverseExit } = require('../src/paper/lib/reverse');

test('buildReverseEntry: LONG original -> SHORT reverse, same entry price/time/qty, stop = original stop distance, target = 2x that distance, rr 2.0', () => {
  // original: LONG, entry 100, stop 95 (distance 5), target 110 (irrelevant to reverse's own levels)
  const original = {
    id: 42, symbol: 'BTCUSDT', trade_date: '2026-11-01', trigger_t: 1000, direction: 'LONG',
    entry_price: 100, entry_time: '2026-11-01T00:00:00.000Z', qty: 2,
    sl_price: 95, target_price: 110, stop_type: 'pattern low - 1x ATR', rr: 2.1, basis: 'LONG because X',
  };
  const r = buildReverseEntry(original);
  assert.equal(r.direction, 'SHORT'); // same as the mirror, opposite of the original
  assert.equal(r.entry_price, 100);
  assert.equal(r.entry_time, original.entry_time);
  assert.equal(r.qty, 2);
  assert.equal(r.trigger_t, 1000);
  // stop distance = |100 - 95| = 5, on the LOSING side of a SHORT = ABOVE entry -> 105
  assert.equal(r.sl_price, 105);
  // target distance = 2 x 5 = 10, on the WINNING side of a SHORT = BELOW entry -> 90
  assert.equal(r.target_price, 90);
  assert.equal(r.rr, 2); // reward:risk is exactly 2.0, by construction
  assert.equal(r.status, 'open');
  assert.equal(r.original_trade_id, 42);
  assert.match(r.basis, /REVERSE of trade #42/);
  assert.match(r.basis, /MIRROR/); // same direction as the mirror, stated explicitly
});

test('buildReverseEntry: SHORT original -> LONG reverse, stop/target mirrored to the other side the same way', () => {
  // original: SHORT, entry 200, stop 210 (distance 10)
  const original = { id: 7, symbol: 'ETHUSDT', direction: 'SHORT', entry_price: 200, entry_time: 't', qty: 1, sl_price: 210, target_price: 180, trade_date: '2026-11-01', trigger_t: 5 };
  const r = buildReverseEntry(original);
  assert.equal(r.direction, 'LONG');
  // stop distance = 10, on the LOSING side of a LONG = BELOW entry -> 190
  assert.equal(r.sl_price, 190);
  // target distance = 20, on the WINNING side of a LONG = ABOVE entry -> 220
  assert.equal(r.target_price, 220);
  assert.equal(r.rr, 2);
});

test('buildReverseEntry: a legacy trade with null sl_price/target_price is resolved via the legacy % rule FIRST (never swaps two nulls)', () => {
  const original = { id: 9, symbol: 'SOLUSDT', direction: 'LONG', entry_price: 100, entry_time: 't', qty: 1, sl_price: null, target_price: null, trade_date: '2026-11-01', trigger_t: 1 };
  const r = buildReverseEntry(original); // legacy crypto rule: stopPct 1% -> stop distance = 1
  assert.equal(r.sl_price, 101); // SHORT, losing side above entry, distance 1
  assert.equal(r.target_price, 98); // SHORT, winning side below entry, distance 2
  assert.match(r.stop_type, /legacy fixed/);
});

test('buildReverseEntry: reward:risk is always exactly 2.0 regardless of the original\'s own rr (its own target is never used)', () => {
  const original = { id: 1, symbol: 'X', direction: 'LONG', entry_price: 50, entry_time: 't', qty: 1, sl_price: 49, target_price: 53, rr: 3.5, trade_date: 'd', trigger_t: 1 };
  const r = buildReverseEntry(original);
  assert.equal(r.rr, 2);
  const stopDist = Math.abs(r.entry_price - r.sl_price);
  const targetDist = Math.abs(r.target_price - r.entry_price);
  assert.equal(targetDist, stopDist * 2);
});

// --- estimateReverseExit (backfill-only, candle-free approximation; see src/paper/lib/reverse.js) ---

test('estimateReverseExit: original hit its own TARGET -> reverse is PROVABLY stopped out (rr >= 1 guarantees the stop distance was crossed first)', () => {
  const original = { exit_reason: 'target', exit_price: 110, exit_time: '2026-11-01T01:00:00Z' };
  const reverseEntry = { direction: 'SHORT', entry_price: 100, sl_price: 105, target_price: 90 };
  const r = estimateReverseExit(original, reverseEntry);
  assert.deepEqual(r, { status: 'closed', exit_price: 105, exit_time: original.exit_time, exit_reason: 'stop', estimated: true });
});

test('estimateReverseExit: original stopped out at exactly the reverse stop distance (the common case) -> genuinely inconclusive, left OPEN', () => {
  // original LONG stopped at 95 (distance 5 against it) = reverse (SHORT) moved exactly 5 in its favor - only halfway to its own 10-wide target
  const original = { exit_reason: 'stop', exit_price: 95, exit_time: '2026-11-01T01:00:00Z' };
  const reverseEntry = { direction: 'SHORT', entry_price: 100, sl_price: 105, target_price: 90 };
  assert.equal(estimateReverseExit(original, reverseEntry), null);
});

test('estimateReverseExit: the original\'s own exit price, by itself, already clears the reverse trade\'s target -> closed target', () => {
  const original = { exit_reason: 'time', exit_price: 89, exit_time: '2026-11-01T01:00:00Z' }; // past the reverse target of 90
  const reverseEntry = { direction: 'SHORT', entry_price: 100, sl_price: 105, target_price: 90 };
  const r = estimateReverseExit(original, reverseEntry);
  assert.deepEqual(r, { status: 'closed', exit_price: 90, exit_time: original.exit_time, exit_reason: 'target', estimated: true });
});

test('estimateReverseExit: the original\'s own exit price, by itself, already clears the reverse trade\'s stop -> closed stop', () => {
  const original = { exit_reason: 'breakeven', exit_price: 106, exit_time: '2026-11-01T01:00:00Z' }; // past the reverse stop of 105
  const reverseEntry = { direction: 'SHORT', entry_price: 100, sl_price: 105, target_price: 90 };
  const r = estimateReverseExit(original, reverseEntry);
  assert.deepEqual(r, { status: 'closed', exit_price: 105, exit_time: original.exit_time, exit_reason: 'stop', estimated: true });
});

test('estimateReverseExit: no stop distance (degenerate row) -> null, never divides by zero or guesses', () => {
  const reverseEntry = { direction: 'LONG', entry_price: 100, sl_price: 100, target_price: 100 };
  assert.equal(estimateReverseExit({ exit_reason: 'stop', exit_price: 95 }, reverseEntry), null);
});
