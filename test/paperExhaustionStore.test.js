'use strict';
// Root-cause fix (Task 2, same bug PR #69 fixed for the 5 mirror tables): node-pg returns NUMERIC/DECIMAL
// columns as STRINGS, never JS numbers. exhaustion_only_trades (src/paper/bots/exhaustion_only/schema.sql)
// declares entry_price/sl_price/target_price/qty/rr/exit_price/gross_pnl_usdt/cost_usdt/net_pnl_usdt/
// gross_pnl_inr/pnl_inr/fx_rate `numeric` - this file reproduces that EXACT shape with a fake pool
// (strings, exactly like real Postgres hands them back), then asserts createPgExhaustionStore() casts
// every one of them to a real `typeof x === 'number'`, and that computeBotStats() (the leaderboard/report
// consumer) produces correct, non-null stats from the result - not the null/NaN the bug produced.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPgExhaustionStore } = require('../src/paper/bots/exhaustion_only/store');
const { computeBotStats } = require('../src/paper/bots/leaderboard/stats');

// A trade row EXACTLY as real Postgres hands it back for every `numeric` column exhaustion_only_trades
// declares - every one of them a STRING (node-pg's default numeric parsing). `id`/`trigger_t` are
// `bigint`, also returned as strings by node-pg, but left untouched by design (same convention as
// mirrorStore.js/paperbot/store.js - nothing in this codebase does strict `===` on a trade row's own id).
function pgStringRow(overrides = {}) {
  return {
    id: '5', symbol: 'ETHUSDT', trade_date: '2026-11-10', status: 'closed', direction: 'LONG', trigger_t: '2000',
    entry_price: '100.50', entry_time: new Date('2026-11-10T10:00:00Z'),
    sl_price: '95.25', target_price: '112.10', stop_type: 'pattern low', target_type: 'swing high',
    qty: '2.5', rr: '2.1', basis: 'exhaustion reversal',
    exit_price: '112.10', exit_time: new Date('2026-11-10T10:30:00Z'), exit_reason: 'target',
    gross_pnl_usdt: '29.00', cost_usdt: '0.58', net_pnl_usdt: '28.42',
    gross_pnl_inr: '2610.00', pnl_inr: '2557.80', fx_rate: '90.00', fx_source: 'coingecko',
    created_at: new Date('2026-11-10T10:00:05Z'),
    ...overrides,
  };
}

function createFakePgPool(rows) {
  return { async query() { return { rows }; } };
}

test('createPgExhaustionStore: closedTrades() casts every NUMERIC column to a real number', async () => {
  const pool = createFakePgPool([pgStringRow()]);
  const store = createPgExhaustionStore(pool);
  const [row] = await store.closedTrades();
  for (const c of ['entry_price', 'sl_price', 'target_price', 'qty', 'rr', 'exit_price', 'gross_pnl_usdt', 'cost_usdt', 'net_pnl_usdt', 'gross_pnl_inr', 'pnl_inr', 'fx_rate']) {
    assert.equal(typeof row[c], 'number', `${c} should be a number, got ${typeof row[c]}`);
  }
  assert.equal(row.entry_price, 100.5);
  assert.equal(row.pnl_inr, 2557.8);
  // untouched
  assert.equal(row.id, '5');
  assert.equal(row.symbol, 'ETHUSDT');
});

test('createPgExhaustionStore: openTrades()/allOpenTrades()/tradesForDay()/listTrades() all cast too (one shared q())', async () => {
  const row = pgStringRow({ status: 'open', exit_price: null, exit_time: null, exit_reason: null, pnl_inr: null, gross_pnl_inr: null, net_pnl_usdt: null, gross_pnl_usdt: null, cost_usdt: null });
  const pool = createFakePgPool([row]);
  const store = createPgExhaustionStore(pool);
  for (const [method, args] of [['openTrades', ['ETHUSDT']], ['allOpenTrades', []], ['tradesForDay', ['2026-11-10']], ['listTrades', [20]]]) {
    const [r] = await store[method](...args);
    assert.equal(typeof r.entry_price, 'number', `${method} did not cast entry_price`);
    assert.equal(typeof r.sl_price, 'number', `${method} did not cast sl_price`);
    assert.equal(typeof r.target_price, 'number', `${method} did not cast target_price`);
    assert.equal(r.pnl_inr, null); // never cast null into 0/NaN
  }
});

test('computeBotStats() on real-Postgres-shaped rows: net INR and win rate are real numbers, not null/NaN (the exact bug this fixes)', async () => {
  const pool = createFakePgPool([
    pgStringRow({ id: '5', pnl_inr: '2557.80' }),
    pgStringRow({ id: '6', pnl_inr: '-820.40', exit_reason: 'stop', direction: 'SHORT' }),
  ]);
  const store = createPgExhaustionStore(pool);
  const rows = await store.closedTrades();
  // Hand-worked: net = 2557.80 + (-820.40) = 1737.40 (BEFORE the fix, pnl_inr is a string, so `netOf`'s
  // `t.pnl_inr ?? ...` returns the STRING and the reduce does string concatenation/NaN arithmetic on the
  // second row - never 1737.40). wins = 1 of 2 -> win rate = 50%.
  const stats = computeBotStats(rows, 1);
  assert.equal(stats.trades, 2);
  assert.equal(stats.netPnlInr, 1737.4);
  assert.equal(stats.winRatePct, 50);
  assert.ok(Number.isFinite(stats.netPnlInr));
  assert.ok(!Number.isNaN(stats.winRatePct));
});
