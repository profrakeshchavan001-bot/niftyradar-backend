'use strict';
// Shared storage for the three research-strategy demo bots (research_usdinr_trend, research_btc_momentum,
// research_nifty200_52whigh - docs/RESEARCH-STRATEGIES-REPORT.md). Same memory/Postgres-pair shape as
// every other own-table bot in this repo (src/paper/lib/mcxStore.js, currencyStore.js): in memory for
// tests and a server with no PAPER_DATABASE_URL, or Postgres via the pool a plugin receives in
// register(ctx). Parametrised by table name so the three bots share one implementation.
//
// Adds one thing none of those need: a tiny per-bot key/value `meta` table, used ONLY to remember whether
// the bot has already sent its one-time "I am live now" Telegram message, so a restart never repeats it
// (CC2 add-on). In memory mode this naturally resets on restart, same as every other in-memory store in
// this repo - a real guarantee needs the Postgres path (PAPER_DATABASE_URL set), same as every other
// bot's "memory is for tests/no-pool, not a persistence promise" convention.
const { castNumericColumns } = require('./numericCast');

function createMemoryResearchStore() {
  const trades = []; const meta = new Map(); let seq = 0;
  return {
    async allOpenTrades() { return trades.filter((t) => t.status === 'open').map((t) => ({ ...t })); },
    async insertTrade(t) {
      const row = { id: ++seq, status: 'open', ...t }; trades.push(row); return row.id;
    },
    async updateTrade(id, patch) { const t = trades.find((x) => x.id === id); if (t) Object.assign(t, patch); },
    async closedTrades() { return trades.filter((t) => t.status === 'closed').map((t) => ({ ...t })); },
    async listTrades(limit = 20) { return trades.slice(-limit).reverse().map((t) => ({ ...t })); },
    async getMeta(key) { return meta.has(key) ? meta.get(key) : null; },
    async setMeta(key, value) { meta.set(key, value); },
    _db: { trades, meta },
  };
}

function createPgResearchStore(pool, tradesTable, metaTable) {
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows.map(castNumericColumns));
  return {
    allOpenTrades: () => q(`SELECT * FROM ${tradesTable} WHERE status = 'open' ORDER BY id`),
    async insertTrade(t) {
      const cols = Object.keys(t); const vals = Object.values(t);
      const r = await pool.query(`INSERT INTO ${tradesTable} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, vals);
      return r.rows[0]?.id ?? null;
    },
    async updateTrade(id, patch) {
      const cols = Object.keys(patch); if (!cols.length) return;
      const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      await pool.query(`UPDATE ${tradesTable} SET ${sets} WHERE id = $1`, [id, ...Object.values(patch)]);
    },
    closedTrades: () => q(`SELECT * FROM ${tradesTable} WHERE status = 'closed' ORDER BY id`),
    listTrades: (limit = 20) => q(`SELECT * FROM ${tradesTable} ORDER BY id DESC LIMIT $1`, [limit]),
    async getMeta(key) {
      const r = await pool.query(`SELECT value FROM ${metaTable} WHERE key = $1`, [key]);
      return r.rows[0]?.value ?? null;
    },
    async setMeta(key, value) {
      await pool.query(`INSERT INTO ${metaTable} (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [key, value]);
    },
  };
}

module.exports = { createMemoryResearchStore, createPgResearchStore };
