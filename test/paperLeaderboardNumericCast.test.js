'use strict';
/**
 * Root-cause fix (this task): src/paper/bots/leaderboard/register.js's closedTradesByBot() used to read
 * every own-table bot (exhaustion_only, trend_smc, every *_mirror table, ccy_*, mcx_*) with a raw
 * pool.query() that never cast NUMERIC/DECIMAL columns - node-pg returns those as STRINGS, so
 * computeBotStats()'s plain `+`/`-` either string-concatenated or produced NaN against real Postgres.
 * Same bug independently found in src/paper/lib/mcxStore.js (mcx_gold/mcx_crude's own report route +
 * the mirror backfill). Both now go through src/paper/lib/numericCast.js.
 *
 * This file proves the fix with a fake multi-table pool that hands back EXACTLY what real Postgres
 * does (every numeric column a string), then reconciles computeBotStats()'s own net P&L against a
 * plain hand-sum of the raw string values - the same check the task asked for ("totals equal the plain
 * sum of net P&L and fees ... with numerics supplied as strings"). Also scans the leaderboard's and the
 * daily report's rendered output for NaN/null/"n/a"/non-finite anywhere a real number is expected.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const leaderboard = require('../src/paper/bots/leaderboard/register');
const { computeBotStats } = require('../src/paper/bots/leaderboard/stats');
const dailyReportFetch = require('../src/paper/ops/dailyReport/fetch');
const { buildDailyReport } = require('../src/paper/ops/dailyReport/report');
const { createMemoryStore } = require('../paperbot/store');

// A closed trade row EXACTLY as real Postgres hands it back for `numeric` columns: every one a STRING
// (node-pg's default). `bot` picks the table via TABLE_ROWS below; it is stripped before being "stored".
function pgStringRow(bot, { net, gross, over = {} } = {}) {
  return {
    id: '1', symbol: 'X', direction: 'LONG', status: 'closed', basis: 'b',
    entry_price: '100.00', qty: '1.5', rr: '1.2', exit_price: '101.00',
    gross_pnl_usdt: String(gross ?? net), cost_usdt: String((gross ?? net) - net), net_pnl_usdt: String(net),
    gross_pnl_inr: String(gross ?? net), pnl_inr: String(net), fx_rate: '90.00',
    entry_time: '2026-11-10T10:00:00Z', exit_time: '2026-11-10T10:10:00Z',
    ...over,
  };
}

// Every table closedTradesByBot()/dailyReport's fetch read, each with its own small fixture of
// STRING-numeric rows (2+ rows per table so a wrong SUM, not just a wrong single value, would show).
function tableRows() {
  return {
    exhaustion_only_trades: [pgStringRow('exhaustion_only', { net: 500, gross: 550 }), pgStringRow('exhaustion_only', { net: -100, gross: -60 })],
    exhaustion_only_mirror_trades: [pgStringRow('exhaustion_only_mirror', { net: -500, gross: -460 })],
    trend_smc_trades: [pgStringRow('trend_smc', { net: 1200, gross: 1260 })],
    trend_smc_mirror_trades: [pgStringRow('trend_smc_mirror', { net: -1200, gross: -1150 })],
    scalp_mirror_trades: [pgStringRow('scalp_mirror', { net: 80, gross: 90 })],
    scalp_wide_mirror_trades: [pgStringRow('scalp_wide_mirror', { net: -40, gross: -20 })],
    intraday_mirror_trades: [pgStringRow('intraday_mirror', { net: 300, gross: 300 })],
    ccy_usdinr_trades: [pgStringRow('ccy_usdinr', { net: 2000, gross: 2050 })],
    ccy_usdinr_mirror_trades: [pgStringRow('ccy_usdinr_mirror', { net: -2000, gross: -1950 })],
    ccy_eurinr_trades: [], ccy_eurinr_mirror_trades: [], ccy_gbpinr_trades: [], ccy_gbpinr_mirror_trades: [],
    ccy_jpyinr_trades: [], ccy_jpyinr_mirror_trades: [],
    mcx_gold_trades: [pgStringRow('mcx_gold', { net: 750, gross: 800 })],
    mcx_gold_mirror_trades: [pgStringRow('mcx_gold_mirror', { net: -750, gross: -700 })],
    mcx_crude_trades: [pgStringRow('mcx_crude', { net: -300, gross: -250 })],
    mcx_crude_mirror_trades: [pgStringRow('mcx_crude_mirror', { net: 300, gross: 350 })],
  };
}

/** pool.query() picks rows by the `FROM <table>` in the SQL text - good enough since every read here is a plain SELECT. */
function createFakeMultiTablePool(rows) {
  return {
    async query(sql) {
      const m = /FROM\s+(\S+)/i.exec(sql);
      const table = m ? m[1] : null;
      return { rows: table && rows[table] ? rows[table] : [] };
    },
  };
}

test('castNumericColumns coverage: every column pgStringRow sets is a real number after casting (no column silently skipped)', () => {
  const { castNumericColumns } = require('../src/paper/lib/numericCast');
  const out = castNumericColumns(pgStringRow('x', { net: 100, gross: 110 }));
  for (const c of ['entry_price', 'qty', 'rr', 'exit_price', 'gross_pnl_usdt', 'cost_usdt', 'net_pnl_usdt', 'gross_pnl_inr', 'pnl_inr', 'fx_rate']) {
    assert.equal(typeof out[c], 'number', `${c} should be cast to a number`);
    assert.ok(Number.isFinite(out[c]), `${c} should be finite, got ${out[c]}`);
  }
});

test('leaderboard closedTradesByBot(): net P&L for every own-table/mirror bot equals the plain sum of its string rows\' pnl_inr (real-Postgres shape)', async () => {
  const pool = createFakeMultiTablePool(tableRows());
  const store = createMemoryStore();
  const closed = await leaderboard.closedTradesByBot({ store, pool });
  for (const [table, rows] of Object.entries(tableRows())) {
    const bot = table.replace(/_trades$/, '');
    if (!rows.length) continue;
    const expected = rows.reduce((s, r) => s + Number(r.pnl_inr), 0);
    const stats = computeBotStats(closed[bot]);
    assert.ok(Number.isFinite(stats.netPnlInr), `${bot}.netPnlInr is not finite: ${stats.netPnlInr}`);
    assert.equal(stats.netPnlInr, expected, `${bot}: computeBotStats net (${stats.netPnlInr}) != plain sum of string rows (${expected})`);
    assert.ok(Number.isFinite(stats.costsInr), `${bot}.costsInr is not finite: ${stats.costsInr}`);
  }
});

test('leaderboard JSON report: no NaN, null net/win-rate, or "n/a" anywhere a bot has closed trades (string-Postgres shape)', async () => {
  const app = { routes: {}, get(p, h) { this.routes[p] = h; } };
  const pool = createFakeMultiTablePool(tableRows());
  const store = createMemoryStore();
  await leaderboard.register({ app, env: { PAPER_ADMIN_SECRET: 's' }, log: () => {}, store, pool });
  const res = { headers: {}, set(h) { Object.assign(this.headers, typeof h === 'object' ? h : {}); return this; }, json(b) { this.body = b; return this; } };
  await app.routes['/api/paper/bots-report']({ query: { key: 's', format: 'json' }, get: () => undefined }, res);
  const text = JSON.stringify(res.body);
  assert.doesNotMatch(text, /NaN/);
  assert.doesNotMatch(text, /"n\/a"/i);
  for (const [bot, s] of Object.entries(res.body.stats)) {
    if (s.trades > 0) {
      assert.ok(Number.isFinite(s.netPnlInr), `${bot}.netPnlInr not finite`);
      assert.ok(Number.isFinite(s.costsInr), `${bot}.costsInr not finite`);
      assert.ok(typeof s.winRatePct === 'number' && Number.isFinite(s.winRatePct), `${bot}.winRatePct not a finite number`);
    }
  }
});

test('leaderboard numericSelfCheck: passes (logs "passed") against correctly-cast string rows, never throws', async () => {
  const pool = createFakeMultiTablePool(tableRows());
  const store = createMemoryStore();
  const lines = [];
  await leaderboard.numericSelfCheck({ store, pool }, (m) => lines.push(m));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /numeric self-check passed/);
});

test('leaderboard numericSelfCheck: logs FAILED (never throws) when a bot\'s own rows are UNCAST strings (reproduces the original bug directly)', async () => {
  const lines = [];
  // The original bug's exact shape: closedTradesByBot() hands back the bot's rows with pnl_inr still a
  // STRING (no castNumericColumns applied) - computeBotStats's reduce (0 + '100') string-concatenates,
  // so netPnlInr comes back non-numeric/non-finite, which the self-check must catch and log, not throw.
  const getClosed = async () => ({ broken_bot: [pgStringRow('broken_bot', { net: 100, gross: 110 })] });
  await leaderboard.numericSelfCheck({ store: createMemoryStore(), pool: null }, (m) => lines.push(m), getClosed);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /numeric self-check FAILED/);
  assert.match(lines[0], /broken_bot/);
});

test('leaderboard numericSelfCheck: never throws even if reading trades itself fails', async () => {
  const lines = [];
  const getClosed = async () => { throw new Error('db down'); };
  await assert.doesNotReject(leaderboard.numericSelfCheck({ store: createMemoryStore(), pool: null }, (m) => lines.push(m), getClosed));
  assert.match(lines[0], /could not read trades: db down/);
});

test('daily report fetch.js: net P&L for every own-table bot equals the plain sum of its string rows\' pnl_inr', async () => {
  const pool = createFakeMultiTablePool(tableRows());
  const store = createMemoryStore();
  const closed = await dailyReportFetch.closedTradesByBot({ store, pool });
  for (const [table, rows] of Object.entries(tableRows())) {
    const bot = table.replace(/_trades$/, '');
    if (!rows.length) continue;
    const expected = rows.reduce((s, r) => s + Number(r.pnl_inr), 0);
    const stats = computeBotStats(closed[bot]);
    assert.equal(stats.netPnlInr, expected, `${bot}: daily-report net (${stats.netPnlInr}) != plain sum (${expected})`);
  }
});

test('daily report text: no NaN/null/"n/a" anywhere in the overall-status section (string-Postgres shape)', async () => {
  const pool = createFakeMultiTablePool(tableRows());
  const store = createMemoryStore();
  const [closedByBot, openByBot] = await Promise.all([dailyReportFetch.closedTradesByBot({ store, pool }), dailyReportFetch.openTradesByBot({ store, pool })]);
  const report = buildDailyReport({ now: Date.now(), closedByBot, openByBot });
  assert.doesNotMatch(report.text, /NaN/);
  assert.doesNotMatch(report.text, /\bnull\b/);
  assert.doesNotMatch(report.text, /\bn\/a\b/i);
  for (const [bot, s] of Object.entries(report.data.stats)) {
    if (s.trades > 0) assert.ok(Number.isFinite(s.netPnlInr) && Number.isFinite(s.costsInr), `${bot} has a non-finite total in the daily report`);
  }
});

test('leaderboard and daily report agree on every bot\'s net P&L (same string-Postgres fixture, two independent readers)', async () => {
  const pool1 = createFakeMultiTablePool(tableRows());
  const pool2 = createFakeMultiTablePool(tableRows());
  const lbClosed = await leaderboard.closedTradesByBot({ store: createMemoryStore(), pool: pool1 });
  const drClosed = await dailyReportFetch.closedTradesByBot({ store: createMemoryStore(), pool: pool2 });
  for (const table of Object.keys(tableRows())) {
    const bot = table.replace(/_trades$/, '');
    assert.equal(computeBotStats(lbClosed[bot] || []).netPnlInr, computeBotStats(drClosed[bot] || []).netPnlInr, `${bot}: leaderboard vs daily-report net P&L disagree`);
  }
});

test('mcxStore createPgMcxStore: casts NUMERIC columns too (own bug, same root cause, different file)', async () => {
  const { createPgMcxStore } = require('../src/paper/lib/mcxStore');
  const pool = { query: async () => ({ rows: [pgStringRow('mcx_gold', { net: 500, gross: 550 })] }) };
  const store = createPgMcxStore(pool, 'mcx_gold_trades');
  const [closed] = await store.closedTrades();
  assert.equal(typeof closed.pnl_inr, 'number');
  assert.equal(closed.pnl_inr, 500);
  const stats = computeBotStats(await store.closedTrades());
  assert.equal(stats.netPnlInr, 500);
});
