'use strict';
// Generic storage for a MIRROR bot's own trade table (docs/BOTS.md "Mirror bots"): same shape as
// src/paper/bots/exhaustion_only/store.js / trend_smc/store.js - own table, in memory for tests and a
// server with no PAPER_DATABASE_URL, or Postgres via the pool a plugin receives in register(ctx). A
// mirror bot's trades NEVER share a row, a table or a virtual balance with the original bot it mirrors
// (docs/BOT-INTERFACE.md "mirror"). Parameterized by table name so every mirror bot gets its own table
// with zero duplicated SQL.
function createMemoryMirrorStore() {
  const trades = []; let seq = 0;
  return {
    async openTrades(symbol) { return trades.filter((t) => t.symbol === symbol && t.status === 'open').map((t) => ({ ...t })); },
    async allOpenTrades() { return trades.filter((t) => t.status === 'open').map((t) => ({ ...t })); },
    async tradesForDay(date) { return trades.filter((t) => t.trade_date === date).map((t) => ({ ...t })); },
    // Sync bookkeeping: has this original trade already been mirrored?
    async byOriginalId(id) { const t = trades.find((x) => x.original_trade_id === id); return t ? { ...t } : null; },
    // CC3-style restart safety: inserting the same original_trade_id twice is a no-op, never a duplicate mirror.
    async insertTrade(t) {
      if (t.original_trade_id != null && trades.some((x) => x.original_trade_id === t.original_trade_id)) return null;
      const row = { id: ++seq, status: 'open', ...t }; trades.push(row); return row.id;
    },
    async updateTrade(id, patch) { const t = trades.find((x) => x.id === id); if (t) Object.assign(t, patch); },
    async closedTrades() { return trades.filter((t) => t.status === 'closed').map((t) => ({ ...t })); },
    async listTrades(limit = 20) { return trades.slice(-limit).reverse().map((t) => ({ ...t })); },
    _db: { trades },
  };
}

// Root-cause fix (mirror P&L stats showed null/NaN against real Postgres - docs/MIRROR-BACKFILL-REPORT.md
// "mirror n/a" on every bot): node-pg returns NUMERIC/DECIMAL columns as STRINGS, never JS numbers, to
// avoid silently losing precision on values the driver cannot represent exactly - every mirror trade table
// (exhaustion_only_mirror/trend_smc_mirror/scalp_mirror/scalp_wide_mirror/intraday_mirror schema.sql, all
// five identical in shape) declares these same columns `numeric`. `computeBotStats`
// (src/paper/bots/leaderboard/stats.js) then does plain arithmetic on them (`+`, `-`), which on a STRING
// either concatenates or silently produces NaN - never a thrown error, so the bug only ever showed up as
// null/NaN in a report, never a crash. `id`/`original_trade_id` are left as strings on purpose (same
// convention as `paperbot/store.js`'s own `NUM_COLS`; nothing in this codebase does strict `===`/
// arithmetic on a mirror row's own id). `trigger_t` is DIFFERENT and WAS the actual root cause of the
// "scalp_wide_reverse: 15 open trades that never close" bug (Group 3b, 2026-11): it is `bigint`, also a
// string from node-pg, and src/paper/scalp/engine.js's evaluateExit() (reused by src/paper/bots/
// scalp_wide_reverse/register.js's own evaluateExitFn - every REVERSE/MIRROR monitor that reads from a
// table built with this store) does ARITHMETIC on it directly: `c.t < trade.trigger_t + MIN`. With
// trigger_t a string, `trigger_t + MIN` is STRING CONCATENATION ("1762000000000" + 300000 ->
// "1762000000000300000"), and `<` then coerces that huge 19-digit string back to a number far bigger
// than any real candle timestamp - so the comparison is true for every candle, `continue` fires every
// time, and the loop never reaches a stop/target/time-stop check at all. paperbot/store.js's own
// NUM_COLS already casts trigger_t for the main paper_trades table (which is why the ORIGINAL scalp_wide
// bot was never affected) - this store just never got the same fix for the mirror/reverse tables built
// on it. Fixed by casting it here too, the one place every mirror AND reverse store read already goes
// through.
const NUMERIC_COLUMNS = ['entry_price', 'qty', 'sl_price', 'target_price', 'rr', 'trigger_t',
  'gross_pnl_usdt', 'cost_usdt', 'net_pnl_usdt', 'gross_pnl_inr', 'pnl_inr', 'fx_rate', 'net_after_fees_corrected'];

// The actual cast now lives in src/paper/lib/numericCast.js (extracted so exhaustion_only/store.js and
// trend_smc/store.js, which have the identical bug against their own `numeric` columns, reuse the same
// helper instead of a third/fourth bespoke copy) - re-exported here with this file's own default column
// list so every existing call site/import in this file is unchanged.
const { castNumericColumns: castNumericColumnsShared } = require('./numericCast');
const castNumericColumns = (row, columns = NUMERIC_COLUMNS) => castNumericColumnsShared(row, columns);

// pool: { query(sql, params) } (the pg Pool a plugin receives via ctx.pool). Mirrors the memory store's shape.
function createPgMirrorStore(pool, tableName) {
  // Every read path goes through this one q() - casting NUMERIC columns here, once, fixes
  // openTrades/allOpenTrades/tradesForDay/byOriginalId/closedTrades/listTrades together (byOriginalId
  // calls q() too, below), rather than repeating the cast at each call site.
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows.map((row) => castNumericColumns(row)));
  return {
    openTrades: (symbol) => q(`SELECT * FROM ${tableName} WHERE symbol = $1 AND status = 'open' ORDER BY id`, [symbol]),
    allOpenTrades: () => q(`SELECT * FROM ${tableName} WHERE status = 'open' ORDER BY id`),
    tradesForDay: (date) => q(`SELECT * FROM ${tableName} WHERE trade_date = $1 ORDER BY id`, [date]),
    async byOriginalId(id) { const r = await q(`SELECT * FROM ${tableName} WHERE original_trade_id = $1 LIMIT 1`, [id]); return r[0] || null; },
    async insertTrade(t) {
      const cols = Object.keys(t); const vals = Object.values(t);
      const r = await pool.query(`INSERT INTO ${tableName} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (original_trade_id) DO NOTHING RETURNING id`, vals);
      return r.rows[0]?.id ?? null;
    },
    async updateTrade(id, patch) {
      const cols = Object.keys(patch); if (!cols.length) return;
      const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      await pool.query(`UPDATE ${tableName} SET ${sets} WHERE id = $1`, [id, ...Object.values(patch)]);
    },
    closedTrades: () => q(`SELECT * FROM ${tableName} WHERE status = 'closed' ORDER BY id`),
    listTrades: (limit = 20) => q(`SELECT * FROM ${tableName} ORDER BY id DESC LIMIT $1`, [limit]),
  };
}

module.exports = { createMemoryMirrorStore, createPgMirrorStore, castNumericColumns, NUMERIC_COLUMNS };
