'use strict';
// Storage for trend_smc, own tables (schema.sql), own market: in memory for tests and for a server with no PAPER_DATABASE_URL,
// or Postgres via the pool a plugin receives in register(ctx) (docs/BOT-INTERFACE.md). Same shape either way, so bot.js never knows which.
function createMemoryTrendSmcStore() {
  const trades = []; const skips = []; let seq = 0;
  return {
    async openTrades(symbol) { return trades.filter((t) => t.symbol === symbol && t.status === 'open').map((t) => ({ ...t })); },
    async allOpenTrades() { return trades.filter((t) => t.status === 'open').map((t) => ({ ...t })); },
    async tradesForDay(date) { return trades.filter((t) => t.trade_date === date).map((t) => ({ ...t })); },
    // CC3 round 3 (restart safety): same dedupe the real unique (symbol, trigger_t) index gives the Postgres store below.
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

// pool: { query(sql, params) } (the pg Pool a plugin receives via ctx.pool). Mirrors the memory store's shape.
function createPgTrendSmcStore(pool) {
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
  return {
    openTrades: (symbol) => q("SELECT * FROM trend_smc_trades WHERE symbol = $1 AND status = 'open' ORDER BY id", [symbol]),
    allOpenTrades: () => q("SELECT * FROM trend_smc_trades WHERE status = 'open' ORDER BY id"),
    tradesForDay: (date) => q('SELECT * FROM trend_smc_trades WHERE trade_date = $1 ORDER BY id', [date]),
    async insertTrade(t) {
      const cols = Object.keys(t); const vals = Object.values(t);
      const r = await pool.query(`INSERT INTO trend_smc_trades (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (symbol, trigger_t) DO NOTHING RETURNING id`, vals);
      return r.rows[0]?.id ?? null;
    },
    async updateTrade(id, patch) {
      const cols = Object.keys(patch); if (!cols.length) return;
      const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      await pool.query(`UPDATE trend_smc_trades SET ${sets} WHERE id = $1`, [id, ...Object.values(patch)]);
    },
    async insertSkip(s) {
      const cols = Object.keys(s); const vals = Object.values(s);
      await pool.query(`INSERT INTO trend_smc_skips (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals);
    },
    closedTrades: () => q("SELECT * FROM trend_smc_trades WHERE status = 'closed' ORDER BY id"),
    skipsSince: (date) => q('SELECT * FROM trend_smc_skips WHERE skip_date >= $1 ORDER BY id', [date]),
    listTrades: (limit = 20) => q('SELECT * FROM trend_smc_trades ORDER BY id DESC LIMIT $1', [limit]),
  };
}

module.exports = { createMemoryTrendSmcStore, createPgTrendSmcStore };
