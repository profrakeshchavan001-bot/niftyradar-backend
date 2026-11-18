'use strict';
// Root-cause fix (mirror P&L stats showed null/NaN against real Postgres - docs/BOTS.md "Mirror bots",
// "mirror n/a" on every bot in docs/MIRROR-BACKFILL-REPORT.md): node-pg returns NUMERIC/DECIMAL columns
// as STRINGS, never JS numbers. This file reproduces that EXACT shape with a fake pool (strings, exactly
// like real Postgres hands them back), then asserts createPgMirrorStore() casts every numeric-looking
// column to a real `typeof x === 'number'`, and that computeBotStats() on the result produces correct,
// non-null stats - not the null/NaN the bug produced.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPgMirrorStore, castNumericColumns, NUMERIC_COLUMNS } = require('../src/paper/lib/mirrorStore');
const { computeBotStats } = require('../src/paper/bots/leaderboard/stats');

// A mirror trade row EXACTLY as real Postgres hands it back for the `numeric` columns every mirror
// table declares (exhaustion_only_mirror/trend_smc_mirror/scalp_mirror/scalp_wide_mirror/intraday_mirror
// schema.sql - all five identical in shape): every one of them a STRING (node-pg's default numeric
// parsing). `id`/`original_trade_id`/`trigger_t` are `bigint`, also returned as strings by node-pg, but
// left untouched BY DESIGN here (see mirrorStore.js's own comment on NUMERIC_COLUMNS) - nothing in this
// codebase does strict `===` on a mirror row's own id.
function pgStringRow(overrides = {}) {
  return {
    id: '7', original_trade_id: '3', symbol: 'BTCUSDT', trade_date: '2026-11-10', status: 'closed',
    direction: 'SHORT', trigger_t: '1000',
    entry_price: '100.50', entry_time: new Date('2026-11-10T10:00:00Z'),
    sl_price: '105.25', target_price: '92.10', stop_type: 'pattern high', target_type: 'swing low',
    qty: '2.5', rr: '2.1', basis: 'mirror of trade #3',
    exit_price: '92.10', exit_time: new Date('2026-11-10T10:30:00Z'), exit_reason: 'target',
    gross_pnl_usdt: '21.00', cost_usdt: '0.58', net_pnl_usdt: '20.42',
    gross_pnl_inr: '1890.00', pnl_inr: '1837.80', fx_rate: '90.00', fx_source: 'coingecko',
    net_after_fees_corrected: '1837.80', // Group 3d (2026-11): backfill-only column, same shape as pnl_inr when set
    created_at: new Date('2026-11-10T10:00:05Z'),
    ...overrides,
  };
}

// pool.query() ignores the SQL text (every createPgMirrorStore() read path is a plain SELECT) and always
// hands back the fixed `rows` given - good enough to prove the casting, which happens AFTER the rows
// come back from `pool.query()`, regardless of which SELECT produced them.
function createFakePgPool(rows) {
  return {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      return { rows };
    },
  };
}

test('castNumericColumns: casts every NUMERIC/DECIMAL mirror column to a real number, leaves everything else untouched', () => {
  const out = castNumericColumns(pgStringRow());
  for (const c of NUMERIC_COLUMNS) assert.equal(typeof out[c], 'number', `${c} should be a number, got ${typeof out[c]}`);
  assert.equal(out.entry_price, 100.5);
  assert.equal(out.qty, 2.5);
  assert.equal(out.pnl_inr, 1837.8);
  assert.equal(out.fx_rate, 90);
  // untouched: strings stay strings, bigint-as-string id stays as-is
  assert.equal(out.symbol, 'BTCUSDT');
  assert.equal(out.status, 'closed');
  assert.equal(out.direction, 'SHORT');
  assert.equal(out.exit_reason, 'target');
  assert.equal(out.id, '7');
});

test('castNumericColumns: a null/undefined numeric column stays null/undefined, never becomes NaN or 0', () => {
  const out = castNumericColumns({ entry_price: null, qty: undefined, pnl_inr: '5' });
  assert.equal(out.entry_price, null);
  assert.equal(out.qty, undefined);
  assert.equal(out.pnl_inr, 5);
});

test('createPgMirrorStore.closedTrades(): reproduces the real bug (string numerics from node-pg), then proves it fixed', async () => {
  const closed = [
    pgStringRow({ id: '7', pnl_inr: '1837.80', gross_pnl_inr: '1890.00' }),
    pgStringRow({ id: '8', pnl_inr: '-620.50', gross_pnl_inr: '-600.00', exit_reason: 'stop', direction: 'LONG' }),
  ];
  const pool = createFakePgPool(closed);
  const store = createPgMirrorStore(pool, 'exhaustion_only_mirror_trades');
  const rows = await store.closedTrades();
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(typeof r.pnl_inr, 'number');
    assert.equal(typeof r.entry_price, 'number');
    assert.equal(typeof r.qty, 'number');
  }

  // Hand-worked: net = 1837.80 + (-620.50) = 1217.30 (BEFORE the fix, pnl_inr is a string, so `netOf`'s
  // `t.pnl_inr ?? ...` returns the STRING, and `closed.reduce((s, t) => s + netOf(t), 0)` does STRING
  // concatenation/NaN arithmetic on the second row - never 1217.30). wins = 1 of 2 (only the first trade's
  // net is > 0) -> win rate = 1/2 * 100 = 50%.
  const stats = computeBotStats(rows, 1);
  assert.equal(stats.trades, 2);
  assert.equal(stats.netPnlInr, 1217.3);
  assert.equal(stats.winRatePct, 50);
  assert.ok(Number.isFinite(stats.netPnlInr), 'must be a real finite number, not NaN - the exact bug this fixes');
  assert.ok(!Number.isNaN(stats.winRatePct));
});

test('createPgMirrorStore: openTrades()/allOpenTrades()/tradesForDay()/listTrades()/byOriginalId() all cast too (one shared q())', async () => {
  const row = pgStringRow({ status: 'open', exit_price: null, exit_time: null, exit_reason: null, pnl_inr: null, gross_pnl_inr: null, net_pnl_usdt: null, gross_pnl_usdt: null, cost_usdt: null });
  const pool = createFakePgPool([row]);
  const store = createPgMirrorStore(pool, 'scalp_mirror_trades');
  for (const [method, args] of [['openTrades', ['BTCUSDT']], ['allOpenTrades', []], ['tradesForDay', ['2026-11-10']], ['listTrades', [20]]]) {
    const rows = await store[method](...args);
    assert.equal(typeof rows[0].entry_price, 'number', `${method} did not cast entry_price`);
    assert.equal(typeof rows[0].qty, 'number', `${method} did not cast qty`);
    assert.equal(typeof rows[0].sl_price, 'number', `${method} did not cast sl_price`);
    assert.equal(typeof rows[0].target_price, 'number', `${method} did not cast target_price`);
  }
  const byOrig = await store.byOriginalId(3);
  assert.equal(typeof byOrig.entry_price, 'number');
  assert.equal(byOrig.pnl_inr, null); // never cast null into 0/NaN
});

test('createMemoryMirrorStore (in-memory, used by other tests) already hands back real numbers - this fix is Postgres-only', async () => {
  const { createMemoryMirrorStore } = require('../src/paper/lib/mirrorStore');
  const store = createMemoryMirrorStore();
  await store.insertTrade({ symbol: 'BTCUSDT', trade_date: '2026-11-10', direction: 'LONG', entry_price: 100, qty: 2, sl_price: 95, target_price: 110 });
  const [row] = await store.allOpenTrades();
  assert.equal(typeof row.entry_price, 'number');
});
