'use strict';
// src/paper/lib/legacyExit.js: the single reconstruction point for a trade's REAL target/stop price
// when its own row predates level-based exits (paperbot/bot.js's cryptoMonitor: "a trade opened before
// level-based exits existed: it finishes on the fixed rule it was opened with" - target_price/sl_price
// stored as null). Every number hand-worked in the comment right above its assertion.
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveExitLevels } = require('../src/paper/lib/legacyExit');

test('resolveExitLevels: both stored -> returned exactly as-is, never touched (the normal, level-based case)', () => {
  const trade = { direction: 'LONG', entry_price: 100, target_price: 110, sl_price: 95 };
  assert.deepEqual(resolveExitLevels(trade, { targetPct: 2, stopPct: 1 }), { target: 110, stop: 95, reconstructed: false });
});

test('resolveExitLevels: LONG legacy trade (both null) -> reconstructed via entry x (1 +/- pct/100), hand-checked', () => {
  // target = 1819.91 * (1 + 2/100) = 1856.3082; stop = 1819.91 * (1 - 1/100) = 1801.7109
  const trade = { direction: 'LONG', entry_price: 1819.91, target_price: null, sl_price: null };
  const r = resolveExitLevels(trade, { targetPct: 2, stopPct: 1 });
  assert.equal(r.reconstructed, true);
  assert.equal(Math.round(r.target * 1e4) / 1e4, 1856.3082);
  assert.equal(Math.round(r.stop * 1e4) / 1e4, 1801.7109);
});

// The exact worked example from the Nov 2026 incident report: ETHUSDT SHORT, entry 1819.91.
test('resolveExitLevels: SHORT legacy trade (both null), the exact ETHUSDT incident entry - target below, stop above entry', () => {
  // short: dir=-1. target = entry*(1 - 2/100) = 1819.91*0.98 = 1783.5118; stop = entry*(1 + 1/100) = 1819.91*1.01 = 1838.1091
  const trade = { direction: 'SHORT', entry_price: 1819.91, target_price: null, sl_price: null };
  const r = resolveExitLevels(trade, { targetPct: 2, stopPct: 1 });
  assert.equal(r.reconstructed, true);
  assert.equal(Math.round(r.target * 1e4) / 1e4, 1783.5118);
  assert.equal(Math.round(r.stop * 1e4) / 1e4, 1838.1091);
  // a SHORT's target must be BELOW entry and its stop ABOVE - sanity check the reconstruction picked the right sign
  assert.ok(r.target < trade.entry_price && trade.entry_price < r.stop);
});

test('resolveExitLevels: PUT (NSE option direction spelling) is treated as short, same as SHORT', () => {
  const trade = { direction: 'PUT', entry_price: 100, target_price: null, sl_price: null };
  const r = resolveExitLevels(trade, { targetPct: 10, stopPct: 5 });
  // target below entry, stop above entry (a PUT profits when the underlying falls)
  assert.ok(r.target < 100 && 100 < r.stop);
});

test('resolveExitLevels: only ONE of target/stop null -> still fully reconstructed (never a half real, half guessed pair)', () => {
  const trade = { direction: 'LONG', entry_price: 100, target_price: 999, sl_price: null }; // 999 would be the wrong, stale number
  const r = resolveExitLevels(trade, { targetPct: 2, stopPct: 1 });
  assert.equal(r.reconstructed, true);
  assert.equal(r.target, 102); // 100 * 1.02, NOT the stored 999
  assert.equal(r.stop, 99); // 100 * 0.99
});

test('resolveExitLevels: no entry_price, or no pct given -> returns the (still null) stored values unreconstructed, never a guess', () => {
  assert.deepEqual(resolveExitLevels({ direction: 'LONG', entry_price: null, target_price: null, sl_price: null }, { targetPct: 2, stopPct: 1 }), { target: null, stop: null, reconstructed: false });
  assert.deepEqual(resolveExitLevels({ direction: 'LONG', entry_price: 100, target_price: null, sl_price: null }), { target: null, stop: null, reconstructed: false });
});

test('resolveExitLevels: a maximally sparse trade (no entry_price at all) never throws and never returns NaN', () => {
  const r = resolveExitLevels({ direction: 'LONG' }, { targetPct: 2, stopPct: 1 });
  assert.equal(r.target, null);
  assert.equal(r.stop, null);
});
