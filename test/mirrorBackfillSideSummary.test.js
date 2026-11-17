'use strict';
// scripts/mirrorBackfill.js's sideSummary(): wins/losses/best/worst trade + the per-trade table (backfill
// bug report problem 3's "trades, wins, losses, net P&L INR, fees INR, best/worst trade" + "plain-text
// table of every replayed trade (#, side, net)"), and the never-negative/never-over-total capital figures
// (problem 1). All hand-worked against the real sideSummary() export, never copied from its own output.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sideSummary } = require('../scripts/mirrorBackfill');

const closed = [
  { id: 3, symbol: 'ETHUSDT', direction: 'SHORT', pnl_inr: -200 },
  { id: 1, symbol: 'BTCUSDT', direction: 'LONG', pnl_inr: 500 },
  { id: 2, symbol: 'SOLUSDT', direction: 'SHORT', pnl_inr: 1200 }, // best
  { id: 4, symbol: 'BTCUSDT', direction: 'LONG', pnl_inr: -900 }, // worst
];

test('sideSummary: wins/losses counts and best/worst trade (symbol + net), hand-checked', () => {
  const s = sideSummary(closed, [], { capitalTotal: 1000, usdInrFallback: 90 });
  assert.equal(s.trades, 4);
  assert.equal(s.wins, 2); // +500, +1200
  assert.equal(s.losses, 2); // -200, -900
  assert.equal(s.bestTradeInr, 1200); assert.equal(s.bestSymbol, 'SOLUSDT');
  assert.equal(s.worstTradeInr, -900); assert.equal(s.worstSymbol, 'BTCUSDT');
});

test('sideSummary: tradeTable is every closed trade, oldest id first, {id, symbol, direction, netPnlInr} - no sampling', () => {
  const s = sideSummary(closed, [], { capitalTotal: 1000, usdInrFallback: 90 });
  assert.equal(s.tradeTable.length, 4);
  assert.deepEqual(s.tradeTable.map((t) => t.id), [1, 2, 3, 4]);
  assert.deepEqual(s.tradeTable[0], { id: 1, symbol: 'BTCUSDT', direction: 'LONG', netPnlInr: 500 });
});

test('sideSummary: zero closed trades -> wins/losses 0, best/worst/table empty, never null crashes or NaN', () => {
  const s = sideSummary([], [], { capitalTotal: 1000, usdInrFallback: 90 });
  assert.deepEqual([s.wins, s.losses, s.bestTradeInr, s.worstTradeInr, s.tradeTable], [0, 0, null, null, []]);
});

test('sideSummary: capitalUsedInr never exceeds capitalTotalInr, even with far more locked capital than total (problem 1)', () => {
  // totalInr = 1000 * 90 = 90,000; 50 open rows x (90*90) = 405,000 locked - far more than the total
  const open = Array.from({ length: 50 }, () => ({ entry_price: 90, qty: 1, fx_rate: 90 }));
  const s = sideSummary([], open, { capitalTotal: 1000, usdInrFallback: 90 });
  assert.equal(s.capitalTotalInr, 90000);
  assert.equal(s.capitalUsedInr, 90000); // capped at the total, never shown as "more used than exists"
});

test('sideSummary: the SAME capitalTotalInr for every call with the same capitalTotal/usdInrFallback, regardless of which/how many trades are passed (problem 1\'s "same INR base for every bot")', () => {
  const a = sideSummary(closed, [], { capitalTotal: 1000, usdInrFallback: 88 });
  const b = sideSummary([], [{ entry_price: 50, qty: 1, fx_rate: 93.38 }], { capitalTotal: 1000, usdInrFallback: 88 });
  assert.equal(a.capitalTotalInr, 88000);
  assert.equal(b.capitalTotalInr, 88000); // a trade's own (different) fx_rate never changes the TOTAL
});
