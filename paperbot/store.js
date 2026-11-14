'use strict';
// Paper bot storage. Two stores with the same methods:
//  - createPgStore(pool): Neon Postgres (tables in sql/paper_bot.sql)
//  - createMemoryStore(): in-process, used by tests and as a loud fallback when
//    PAPER_DATABASE_URL is not set (data is then lost on restart).
const fs = require('fs');
const path = require('path');

const TRADE_COLS = ['market', 'symbol', 'trade_date', 'status', 'r_factor', 'score_source', 'direction', 'patterns',
  'trigger_candles', 'trigger_t', 'trend_state', 'smc_tags', 'news_filter', 'instrument', 'simulated_option',
  'price_source', 'candle_source', 'qty', 'entry_price', 'entry_time', 'entry_underlying', 'exit_price', 'exit_time',
  'exit_underlying', 'exit_reason', 'pnl_inr', 'fx_rate', 'fx_source', 'max_fav_pct', 'max_adv_pct', 'basis', 'legacy_rf', 'r_detail',
  'judge_score', 'judge_take', 'judge_contributions', 'judge_basis', // judge_*: docs/JUDGE.md
  'data_source', 'data_delay_sec']; // NSE candle feed of the trade: "dhan" or "yahoo", and the observed delay in seconds
const JSON_COLS = new Set(['patterns', 'trigger_candles', 'trend_state', 'smc_tags', 'data', 'value', 'r_detail', 'judge_contributions']);
const NUM_COLS = ['id', 'r_factor', 'trigger_t', 'qty', 'entry_price', 'entry_underlying', 'exit_price', 'exit_underlying',
  'pnl_inr', 'fx_rate', 'max_fav_pct', 'max_adv_pct', 'legacy_rf', 'judge_score', 'data_delay_sec'];
const SKIP_COLS = ['market', 'symbol', 'skip_date', 'reason', 'r_factor', 'patterns', 'trend_state'];

const clampLimit = (n, max = 500) => Math.min(Math.max(parseInt(n, 10) || 50, 1), max);

function createMemoryStore() {
  const db = { config: {}, trades: [], skips: [], summaries: [] };
  let seq = 0;
  const copy = (x) => JSON.parse(JSON.stringify(x));
  return {
    kind: 'memory',
    async init() {},
    async getConfig() { return copy(db.config); },
    async setConfigIfMissing(key, value) { if (!(key in db.config)) db.config[key] = copy(value); },
    async insertTrade(t) { const row = { id: ++seq, status: 'open', ...copy(t) }; db.trades.push(row); return row.id; },
    async updateTrade(id, fields) { const row = db.trades.find((t) => t.id === id); if (row) Object.assign(row, copy(fields)); },
    async noteTrade(id, fields) { return this.updateTrade(id, fields); },
    async openTrades(market) { return copy(db.trades.filter((t) => t.market === market && t.status === 'open')); },
    async tradesForDay(market, date) { return copy(db.trades.filter((t) => t.market === market && t.trade_date === date)); },
    async closedTrades(market) { return copy(db.trades.filter((t) => t.status === 'closed' && (!market || t.market === market))); },
    async insertSkip(s) { db.skips.push({ id: ++seq, ...copy(s) }); },
    async skipsSince(date) { return copy(db.skips.filter((s) => s.skip_date >= date)); },
    async saveSummary(s) { db.summaries.push({ id: ++seq, ...copy(s) }); },
    async listSummaries(limit) { return copy(db.summaries.slice(-clampLimit(limit)).reverse()); },
    async listTrades(limit) { return copy(db.trades.slice(-clampLimit(limit)).reverse()); },
    async listSkips(limit) { return copy(db.skips.slice(-clampLimit(limit)).reverse()); },
    _db: db,
  };
}

function fromRow(row) {
  const out = { ...row };
  for (const c of NUM_COLS) if (out[c] != null) out[c] = Number(out[c]);
  for (const c of ['trade_date', 'skip_date', 'summary_date']) {
    if (out[c] instanceof Date) {
      const d = out[c];
      out[c] = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
  }
  for (const c of ['entry_time', 'exit_time', 'created_at']) if (out[c] instanceof Date) out[c] = out[c].toISOString();
  return out;
}

const toParam = (col, v) => (v !== undefined && v !== null && JSON_COLS.has(col) ? JSON.stringify(v) : v === undefined ? null : v);

// `getPool` is called on first use only (lazy connect). The tables are created
// on that first connect (sql/paper_bot.sql is idempotent); a failed attempt is
// tried again on the next query.
function createPgStore(getPool) {
  let conn = null;
  let ready = null;
  const db = () => { if (!conn) conn = typeof getPool === 'function' ? getPool() : getPool; return conn; };
  const ensure = () => {
    if (!ready) {
      ready = db().query(fs.readFileSync(path.join(__dirname, '..', 'sql', 'paper_bot.sql'), 'utf8')).catch((e) => { ready = null; throw e; });
    }
    return ready;
  };
  const pool = { query: async (text, params) => { await ensure(); return db().query(text, params); } };
  const q = async (text, params) => (await pool.query(text, params)).rows.map(fromRow);
  return {
    kind: 'postgres',
    init: ensure,
    async noteTrade(id, fields) { return this.updateTrade(id, fields); },
    async getConfig() {
      const rows = await q('SELECT key, value FROM paper_config');
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
    async setConfigIfMissing(key, value) {
      await pool.query('INSERT INTO paper_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify(value)]);
    },
    async insertTrade(t) {
      const cols = TRADE_COLS.filter((c) => t[c] !== undefined);
      const rows = await q(`INSERT INTO paper_trades (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        cols.map((c) => toParam(c, t[c])));
      return rows[0].id;
    },
    async updateTrade(id, fields) {
      const cols = Object.keys(fields).filter((c) => TRADE_COLS.includes(c));
      if (!cols.length) return;
      await pool.query(`UPDATE paper_trades SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [id, ...cols.map((c) => toParam(c, fields[c]))]);
    },
    openTrades: (market) => q("SELECT * FROM paper_trades WHERE market = $1 AND status = 'open' ORDER BY id", [market]),
    tradesForDay: (market, date) => q('SELECT * FROM paper_trades WHERE market = $1 AND trade_date = $2 ORDER BY id', [market, date]),
    closedTrades: (market) => q("SELECT * FROM paper_trades WHERE status = 'closed' AND ($1::text IS NULL OR market = $1) ORDER BY id", [market || null]),
    async insertSkip(s) {
      await pool.query(`INSERT INTO paper_skips (${SKIP_COLS.join(', ')}) VALUES (${SKIP_COLS.map((_, i) => `$${i + 1}`).join(', ')})`,
        SKIP_COLS.map((c) => toParam(c, s[c])));
    },
    skipsSince: (date) => q('SELECT * FROM paper_skips WHERE skip_date >= $1 ORDER BY id', [date]),
    async saveSummary(s) {
      await pool.query('INSERT INTO daily_summaries (kind, summary_date, body, data, telegram_sent) VALUES ($1, $2, $3, $4, $5)',
        [s.kind, s.summary_date, s.body, JSON.stringify(s.data || null), !!s.telegram_sent]);
    },
    listSummaries: (limit) => q('SELECT * FROM daily_summaries ORDER BY id DESC LIMIT $1', [clampLimit(limit)]),
    listTrades: (limit) => q('SELECT * FROM paper_trades ORDER BY id DESC LIMIT $1', [clampLimit(limit)]),
    listSkips: (limit) => q('SELECT * FROM paper_skips ORDER BY id DESC LIMIT $1', [clampLimit(limit)]),
  };
}

// Write-through cache in front of a store, so the minute-by-minute jobs do not
// poll the database. Open trades and the day's trades are read once and then
// kept in step in memory; the config is re-read at most every 10 minutes;
// best / worst % of an open trade stays in memory until the trade closes.
// Steady state with no trade event = zero queries.
function createCachedStore(inner, { now = Date.now, configTtlMs = 600000 } = {}) {
  const copy = (x) => JSON.parse(JSON.stringify(x));
  const open = new Map(); // market -> rows
  let day = new Map(); // `${market}|${date}` -> rows
  let cfg = null;
  const rowsOf = (id) => [...open.values(), ...day.values()].flat().filter((t) => t.id === id);
  return {
    ...inner,
    kind: inner.kind,
    init: () => inner.init(),
    async getConfig() {
      if (!cfg || now() - cfg.at > configTtlMs) cfg = { value: await inner.getConfig(), at: now() };
      return copy(cfg.value);
    },
    async setConfigIfMissing(key, value) { await inner.setConfigIfMissing(key, value); cfg = null; },
    async openTrades(market) {
      if (!open.has(market)) open.set(market, await inner.openTrades(market));
      return copy(open.get(market));
    },
    async tradesForDay(market, date) {
      const key = `${market}|${date}`;
      if (!day.has(key)) {
        day = new Map([...day].filter(([k]) => k.endsWith(`|${date}`))); // drop older days
        day.set(key, await inner.tradesForDay(market, date));
      }
      return copy(day.get(key));
    },
    async insertTrade(t) {
      const id = await inner.insertTrade(t);
      const row = { status: 'open', ...copy(t), id };
      if (open.has(t.market)) open.get(t.market).push(row);
      const key = `${t.market}|${t.trade_date}`;
      if (day.has(key)) day.get(key).push({ ...row });
      return id;
    },
    async updateTrade(id, fields) {
      await inner.updateTrade(id, fields);
      for (const row of rowsOf(id)) Object.assign(row, copy(fields));
      if (fields.status === 'closed') for (const [m, rows] of open) open.set(m, rows.filter((t) => t.id !== id));
    },
    async noteTrade(id, fields) { for (const row of rowsOf(id)) Object.assign(row, copy(fields)); },
  };
}

module.exports = { createMemoryStore, createPgStore, createCachedStore, clampLimit };
