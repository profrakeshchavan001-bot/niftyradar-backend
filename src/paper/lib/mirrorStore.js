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

// pool: { query(sql, params) } (the pg Pool a plugin receives via ctx.pool). Mirrors the memory store's shape.
function createPgMirrorStore(pool, tableName) {
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
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

module.exports = { createMemoryMirrorStore, createPgMirrorStore };
