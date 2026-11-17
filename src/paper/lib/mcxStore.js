'use strict';
// Shared storage shape for the MCX bots (mcx_gold, mcx_crude - own tables, own schema.sql each, see
// docs/BOT-INTERFACE.md). Same interface as src/paper/bots/exhaustion_only/store.js / trend_smc/store.js:
// in memory for tests and a server with no PAPER_DATABASE_URL, or Postgres via the pool a plugin receives
// in register(ctx). Parametrised by table name so mcx_gold and mcx_crude (two separate tables, two
// separate virtual balances) share this one implementation instead of two near-identical copies.
function createMemoryMcxStore() {
  const trades = []; const skips = []; let seq = 0;
  return {
    async openTrades(symbol) { return trades.filter((t) => t.symbol === symbol && t.status === 'open').map((t) => ({ ...t })); },
    async allOpenTrades() { return trades.filter((t) => t.status === 'open').map((t) => ({ ...t })); },
    async tradesForDay(date) { return trades.filter((t) => t.trade_date === date).map((t) => ({ ...t })); },
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

function createPgMcxStore(pool, table) {
  const skipsTable = `${table}_skips`;
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
  return {
    openTrades: (symbol) => q(`SELECT * FROM ${table} WHERE symbol = $1 AND status = 'open' ORDER BY id`, [symbol]),
    allOpenTrades: () => q(`SELECT * FROM ${table} WHERE status = 'open' ORDER BY id`),
    tradesForDay: (date) => q(`SELECT * FROM ${table} WHERE trade_date = $1 ORDER BY id`, [date]),
    async insertTrade(t) {
      const cols = Object.keys(t); const vals = Object.values(t);
      const r = await pool.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (symbol, trigger_t) DO NOTHING RETURNING id`, vals);
      return r.rows[0]?.id ?? null;
    },
    async updateTrade(id, patch) {
      const cols = Object.keys(patch); if (!cols.length) return;
      const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      await pool.query(`UPDATE ${table} SET ${sets} WHERE id = $1`, [id, ...Object.values(patch)]);
    },
    async insertSkip(s) {
      const cols = Object.keys(s); const vals = Object.values(s);
      await pool.query(`INSERT INTO ${skipsTable} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals);
    },
    closedTrades: () => q(`SELECT * FROM ${table} WHERE status = 'closed' ORDER BY id`),
    skipsSince: (date) => q(`SELECT * FROM ${skipsTable} WHERE skip_date >= $1 ORDER BY id`, [date]),
    listTrades: (limit = 20) => q(`SELECT * FROM ${table} ORDER BY id DESC LIMIT $1`, [limit]),
  };
}

module.exports = { createMemoryMcxStore, createPgMcxStore };
