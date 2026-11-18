'use strict';
// Storage for confluence_flow (Bot B): same memory/Postgres pair shape as confluence/store.js, plus the
// order-flow sample table (GROUP 3's small persisted sample, for later study - never read live by the bot).
const { createMemoryResearchStore, createPgResearchStore } = require('../../lib/researchStore');
const { castNumericColumns } = require('../../lib/numericCast');

const NUMERIC_COLUMNS = ['entry_price', 'sl_price', 'target_price', 'qty', 'rr', 'exit_price',
  'gross_pnl_usdt', 'cost_usdt', 'net_pnl_usdt', 'gross_pnl_inr', 'pnl_inr', 'fx_rate', 'flow_strength'];

function createMemoryConfluenceFlowStore() {
  const base = createMemoryResearchStore();
  const skips = []; const samples = []; let seq = 0;
  return {
    ...base,
    async openTrades(symbol) { return base._db.trades.filter((t) => t.symbol === symbol && t.status === 'open').map((t) => ({ ...t })); },
    async tradesForDay(date) { return base._db.trades.filter((t) => t.trade_date === date).map((t) => ({ ...t })); },
    async insertTrade(t) {
      if (t.trigger_t != null && base._db.trades.some((x) => x.symbol === t.symbol && x.trigger_t === t.trigger_t)) return null;
      return base.insertTrade(t);
    },
    async insertSkip(s) { skips.push({ id: ++seq, ...s }); },
    async skipsSince(date) { return skips.filter((s) => s.skip_date >= date).map((s) => ({ ...s })); },
    async insertFlowSample(s) {
      if (samples.some((x) => x.symbol === s.symbol && x.trigger_t === s.trigger_t)) return null;
      samples.push({ id: ++seq, ...s }); return seq;
    },
    async flowSamplesSince(date) { return samples.filter((s) => s.sample_date >= date).map((s) => ({ ...s })); },
    _samples: samples,
  };
}

function createPgConfluenceFlowStore(pool, tradesTable, metaTable, skipsTable, samplesTable) {
  const base = createPgResearchStore(pool, tradesTable, metaTable);
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows.map((row) => castNumericColumns(row, NUMERIC_COLUMNS)));
  return {
    ...base,
    openTrades: (symbol) => q(`SELECT * FROM ${tradesTable} WHERE symbol = $1 AND status = 'open' ORDER BY id`, [symbol]),
    tradesForDay: (date) => q(`SELECT * FROM ${tradesTable} WHERE trade_date = $1 ORDER BY id`, [date]),
    async insertTrade(t) {
      const cols = Object.keys(t); const vals = Object.values(t);
      const r = await pool.query(`INSERT INTO ${tradesTable} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (symbol, trigger_t) DO NOTHING RETURNING id`, vals);
      return r.rows[0]?.id ?? null;
    },
    async insertSkip(s) {
      const cols = Object.keys(s); const vals = Object.values(s);
      await pool.query(`INSERT INTO ${skipsTable} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals);
    },
    skipsSince: (date) => q(`SELECT * FROM ${skipsTable} WHERE skip_date >= $1 ORDER BY id`, [date]),
    async insertFlowSample(s) {
      const cols = Object.keys(s); const vals = Object.values(s);
      const r = await pool.query(`INSERT INTO ${samplesTable} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (symbol, trigger_t) DO NOTHING RETURNING id`, vals);
      return r.rows[0]?.id ?? null;
    },
    flowSamplesSince: (date) => q(`SELECT * FROM ${samplesTable} WHERE sample_date >= $1 ORDER BY id`, [date]),
  };
}

module.exports = { createMemoryConfluenceFlowStore, createPgConfluenceFlowStore };
