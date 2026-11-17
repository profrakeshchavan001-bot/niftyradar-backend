'use strict';
// Root-cause fix (Task 2, same bug PR #69 fixed for the 5 mirror tables): node-pg returns NUMERIC/DECIMAL
// columns as STRINGS, never JS numbers. trend_smc_trades (src/paper/bots/trend_smc/schema.sql) declares
// entry_price/sl_price/target_price/qty/rr/exit_price/gross_pnl_usdt/cost_usdt/net_pnl_usdt/
// gross_pnl_inr/pnl_inr/fx_rate `numeric` - this file reproduces that EXACT shape with a fake pool
// (strings, exactly like real Postgres hands them back), then asserts createPgTrendSmcStore() casts
// every one of them to a real `typeof x === 'number'`, and that computeBotStats() (the leaderboard/report
// consumer) produces correct, non-null stats from the result - not the null/NaN the bug produced.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPgTrendSmcStore } = require('../src/paper/bots/trend_smc/store');
const { computeBotStats } = require('../src/paper/bots/leaderboard/stats');

function pgStringRow(overrides = {}) {
  return {
    id: '9', symbol: 'SOLUSDT', trade_date: '2026-11-10', status: 'closed', direction: 'SHORT', trigger_t: '3000',
    entry_price: '200.75', entry_time: new Date('2026-11-10T11:00:00Z'),
    sl_price: '210.00', target_price: '180.50', stop_type: 'order block + 1xATR', target_type: 'swing low',
    qty: '4', rr: '1.8', trend15: 'down', zone: 'premium', basis: 'order block retest, EMA9<21',
    exit_price: '180.50', exit_time: new Date('2026-11-10T11:45:00Z'), exit_reason: 'target',
    gross_pnl_usdt: '81.00', cost_usdt: '1.85', net_pnl_usdt: '79.15',
    gross_pnl_inr: '7290.00', pnl_inr: '7123.50', fx_rate: '90.00', fx_source: 'coingecko',
    created_at: new Date('2026-11-10T11:00:05Z'),
    ...overrides,
  };
}

function createFakePgPool(rows) {
  return { async query() { return { rows }; } };
}

test('createPgTrendSmcStore: closedTrades() casts every NUMERIC column to a real number', async () => {
  const pool = createFakePgPool([pgStringRow()]);
  const store = createPgTrendSmcStore(pool);
  const [row] = await store.closedTrades();
  for (const c of ['entry_price', 'sl_price', 'target_price', 'qty', 'rr', 'exit_price', 'gross_pnl_usdt', 'cost_usdt', 'net_pnl_usdt', 'gross_pnl_inr', 'pnl_inr', 'fx_rate']) {
    assert.equal(typeof row[c], 'number', `${c} should be a number, got ${typeof row[c]}`);
  }
  assert.equal(row.entry_price, 200.75);
  assert.equal(row.pnl_inr, 7123.5);
  // untouched
  assert.equal(row.id, '9');
  assert.equal(row.trend15, 'down');
  assert.equal(row.zone, 'premium');
});

test('createPgTrendSmcStore: openTrades()/allOpenTrades()/tradesForDay()/listTrades() all cast too (one shared q())', async () => {
  const row = pgStringRow({ status: 'open', exit_price: null, exit_time: null, exit_reason: null, pnl_inr: null, gross_pnl_inr: null, net_pnl_usdt: null, gross_pnl_usdt: null, cost_usdt: null });
  const pool = createFakePgPool([row]);
  const store = createPgTrendSmcStore(pool);
  for (const [method, args] of [['openTrades', ['SOLUSDT']], ['allOpenTrades', []], ['tradesForDay', ['2026-11-10']], ['listTrades', [20]]]) {
    const [r] = await store[method](...args);
    assert.equal(typeof r.entry_price, 'number', `${method} did not cast entry_price`);
    assert.equal(typeof r.sl_price, 'number', `${method} did not cast sl_price`);
    assert.equal(typeof r.target_price, 'number', `${method} did not cast target_price`);
    assert.equal(r.pnl_inr, null); // never cast null into 0/NaN
  }
});

test('computeBotStats() on real-Postgres-shaped rows: net INR and win rate are real numbers, not null/NaN (the exact bug this fixes)', async () => {
  const pool = createFakePgPool([
    pgStringRow({ id: '9', pnl_inr: '7123.50' }),
    pgStringRow({ id: '10', pnl_inr: '-1340.20', exit_reason: 'stop', direction: 'LONG' }),
  ]);
  const store = createPgTrendSmcStore(pool);
  const rows = await store.closedTrades();
  // Hand-worked: net = 7123.50 + (-1340.20) = 5783.30 (BEFORE the fix, pnl_inr is a string, so the
  // reduce does string concatenation/NaN arithmetic on the second row - never 5783.30). wins = 1 of 2
  // -> win rate = 50%.
  const stats = computeBotStats(rows, 1);
  assert.equal(stats.trades, 2);
  assert.equal(stats.netPnlInr, 5783.3);
  assert.equal(stats.winRatePct, 50);
  assert.ok(Number.isFinite(stats.netPnlInr));
  assert.ok(!Number.isNaN(stats.winRatePct));
});
