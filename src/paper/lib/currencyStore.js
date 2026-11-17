'use strict';
// Storage for a ccy_* bot's own trades/skips tables - same shape as src/paper/bots/exhaustion_only/store.js,
// parameterized by table name (same idea as src/paper/lib/mirrorStore.js's createPgMirrorStore(pool, tableName))
// so the four currency pairs share this one file with zero duplicated SQL, instead of four near-identical
// store.js copies. In memory for tests and a server with no PAPER_DATABASE_URL, or Postgres via the pool a
// plugin receives in register(ctx) (docs/BOT-INTERFACE.md). Same shape either way, so bot.js never knows which.
const NUMERIC_COLUMNS = ['entry_price', 'qty', 'sl_price', 'target_price', 'rr', 'gross_pnl_inr', 'cost_inr', 'net_pnl_inr', 'pnl_inr'];

// node-pg returns NUMERIC/DECIMAL columns as strings (see src/paper/lib/mirrorStore.js's own comment on
// the exact same issue for mirror tables) - cast them back to real numbers so computeBotStats()
// (src/paper/bots/leaderboard/stats.js) does plain arithmetic on numbers, not string concatenation.
function castNumericColumns(row) {
  if (!row) return row;
  const out = { ...row };
  for (const c of NUMERIC_COLUMNS) if (out[c] != null) out[c] = Number(out[c]);
  return out;
}

function createMemoryCurrencyStore() {
  const trades = []; const skips = []; let seq = 0;
  return {
    async openTrades(symbol) { return trades.filter((t) => t.symbol === symbol && t.status === 'open').map((t) => ({ ...t })); },
    async allOpenTrades() { return trades.filter((t) => t.status === 'open').map((t) => ({ ...t })); },
    async tradesForDay(date) { return trades.filter((t) => t.trade_date === date).map((t) => ({ ...t })); },
    // Restart safety: one trade per trigger candle per symbol, same convention as every other bot's (symbol, trigger_t) unique index.
    async insertTrade(t) {
      if (t.trigger_t != null && trades.some((x) => x.symbol === t.symbol && x.trigger_t === t.trigger_t)) return null;
      const row = { id: ++seq, status: 'open', ...t }; trades.push(row); return row.id;
    },
    async updateTrade(id, patch) { const t = trades.find((x) => x.id === id); if (t) Object.assign(t, patch); },
    async insertSkip(s) { skips.push({ id: ++seq, ...s }); },
    async closedTrades() { return trades.filter((t) => t.status === 'closed').map((t) => ({ ...t })); },
    async skipsSince(date) { return skips.filter((s) => s.skip_date >= date).map((s) => ({ ...s })); },
    async listTrades(limit = 20) { return trades.slice(-limit).reverse().map((t) => ({ ...t })); },
    _db: { trades, skips },
  };
}

// pool: { query(sql, params) } (the pg Pool a plugin receives via ctx.pool). `tradesTable`/`skipsTable`:
// this pair's own tables (e.g. ccy_usdinr_trades / ccy_usdinr_skips - see each bot's own schema.sql).
function createPgCurrencyStore(pool, tradesTable, skipsTable) {
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows.map(castNumericColumns));
  return {
    openTrades: (symbol) => q(`SELECT * FROM ${tradesTable} WHERE symbol = $1 AND status = 'open' ORDER BY id`, [symbol]),
    allOpenTrades: () => q(`SELECT * FROM ${tradesTable} WHERE status = 'open' ORDER BY id`),
    tradesForDay: (date) => q(`SELECT * FROM ${tradesTable} WHERE trade_date = $1 ORDER BY id`, [date]),
    async insertTrade(t) {
      const cols = Object.keys(t); const vals = Object.values(t);
      const r = await pool.query(`INSERT INTO ${tradesTable} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (symbol, trigger_t) DO NOTHING RETURNING id`, vals);
      return r.rows[0]?.id ?? null;
    },
    async updateTrade(id, patch) {
      const cols = Object.keys(patch); if (!cols.length) return;
      const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      await pool.query(`UPDATE ${tradesTable} SET ${sets} WHERE id = $1`, [id, ...Object.values(patch)]);
    },
    async insertSkip(s) {
      const cols = Object.keys(s); const vals = Object.values(s);
      await pool.query(`INSERT INTO ${skipsTable} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals);
    },
    closedTrades: () => q(`SELECT * FROM ${tradesTable} WHERE status = 'closed' ORDER BY id`),
    skipsSince: (date) => q(`SELECT * FROM ${skipsTable} WHERE skip_date >= $1 ORDER BY id`, [date]),
    listTrades: (limit = 20) => q(`SELECT * FROM ${tradesTable} ORDER BY id DESC LIMIT $1`, [limit]),
  };
}

module.exports = { createMemoryCurrencyStore, createPgCurrencyStore };
