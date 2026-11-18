'use strict';
// Storage for nse-MIRROR / nse-REVERSE (Group 4, 2026-11): same memory/Postgres-pair shape as every
// other own-table bot in this repo, but needs BOTH things no single existing generic store already
// combines - src/paper/lib/mirrorStore.js's byOriginalId() dedupe (so a sync() tick never opens a second
// side-trade for the same original) AND src/paper/lib/researchStore.js's getMeta/setMeta (so the one-time
// "I am live now" Telegram message, src/paper/lib/liveAnnounce.js, survives a restart). Rather than
// bolting one onto the other, this is its own tiny module, parametrised by table name so nse_mirror and
// nse_reverse share one implementation - same convention as mcxStore.js/currencyStore.js/researchStore.js.
const { castNumericColumns } = require('./numericCast');

const NUMERIC_COLUMNS = ['entry_price', 'entry_underlying', 'exit_price', 'exit_underlying', 'strike', 'qty',
  'sl_price', 'target_price', 'pnl_inr', 'max_fav_pct', 'max_adv_pct'];

function createMemoryNseSideStore() {
  const trades = []; const meta = new Map(); let seq = 0;
  return {
    async allOpenTrades() { return trades.filter((t) => t.status === 'open').map((t) => ({ ...t })); },
    async byOriginalId(id) { const t = trades.find((x) => x.original_trade_id === id); return t ? { ...t } : null; },
    async insertTrade(t) {
      if (t.original_trade_id != null && trades.some((x) => x.original_trade_id === t.original_trade_id)) return null;
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

function createPgNseSideStore(pool, tradesTable, metaTable) {
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows.map((row) => castNumericColumns(row, NUMERIC_COLUMNS)));
  return {
    allOpenTrades: () => q(`SELECT * FROM ${tradesTable} WHERE status = 'open' ORDER BY id`),
    async byOriginalId(id) { const r = await q(`SELECT * FROM ${tradesTable} WHERE original_trade_id = $1 LIMIT 1`, [id]); return r[0] || null; },
    async insertTrade(t) {
      const cols = Object.keys(t); const vals = Object.values(t);
      const r = await pool.query(`INSERT INTO ${tradesTable} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (original_trade_id) DO NOTHING RETURNING id`, vals);
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

module.exports = { createMemoryNseSideStore, createPgNseSideStore, NUMERIC_COLUMNS };
