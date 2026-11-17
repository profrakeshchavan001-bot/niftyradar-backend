'use strict';
/**
 * Daily Telegram report (05:00 IST): data gathering only, no text, no Telegram. Reuses the exact same
 * stores every other report/leaderboard already reads - nothing new added to any bot's schema.
 *
 * UNLIKE src/paper/bots/leaderboard/register.js's closedTradesByBot() (which queries the "own table"
 * bots with a raw pool.query and never casts the result), every row read here for an own-table bot goes
 * through castNumericColumns (src/paper/lib/numericCast.js): node-pg returns NUMERIC/DECIMAL columns as
 * STRINGS, and this report's INR totals must be real numbers, not string concatenation or NaN (the same
 * bug docs/BOTS.md says was fixed for the five mirror stores' OWN report routes - this file applies the
 * same fix to this report's own reads instead of trusting the leaderboard's un-cast path).
 */
const { castNumericColumns } = require('../../lib/numericCast');

// Superset of every numeric column across every own-table bot's schema.sql (exhaustion_only, trend_smc,
// the five mirror tables, ccy_*, mcx_*) - castNumericColumns skips a column that is not present on a
// given row, so one shared list is safe for every table.
const NUMERIC_COLS = [
  'entry_price', 'exit_price', 'sl_price', 'target_price', 'qty', 'rr', 'r_factor',
  'gross_pnl_usdt', 'cost_usdt', 'net_pnl_usdt', 'gross_pnl_inr', 'pnl_inr', 'net_pnl_inr', 'cost_inr', 'fx_rate',
];

// Bot (table name is `${bot}_trades`) -> the ctx key its own register.js sets for the no-pool
// (memory/test) fallback - the exact same keys src/paper/bots/leaderboard/register.js's
// closedTradesByBot() already uses ("the 'Memory' in the name is historical, not a guarantee": it holds
// the real store either way).
const OWN_TABLE_BOTS = {
  exhaustion_only: 'exhaustionMemoryStore', exhaustion_only_mirror: 'exhaustionMirrorMemoryStore',
  trend_smc: 'trendSmcMemoryStore', trend_smc_mirror: 'trendSmcMirrorMemoryStore',
  scalp_mirror: 'scalpMirrorMemoryStore', scalp_wide_mirror: 'scalpWideMirrorMemoryStore',
  intraday_mirror: 'intradayMirrorMemoryStore',
  ccy_usdinr: 'ccyUsdinrMemoryStore', ccy_usdinr_mirror: 'ccyUsdinrMirrorMemoryStore',
  ccy_eurinr: 'ccyEurinrMemoryStore', ccy_eurinr_mirror: 'ccyEurinrMirrorMemoryStore',
  ccy_gbpinr: 'ccyGbpinrMemoryStore', ccy_gbpinr_mirror: 'ccyGbpinrMirrorMemoryStore',
  ccy_jpyinr: 'ccyJpyinrMemoryStore', ccy_jpyinr_mirror: 'ccyJpyinrMirrorMemoryStore',
  mcx_gold: 'mcxGoldMemoryStore', mcx_gold_mirror: 'mcxGoldMirrorMemoryStore',
  mcx_crude: 'mcxCrudeMemoryStore', mcx_crude_mirror: 'mcxCrudeMirrorMemoryStore',
};

// Original -> mirror bot name, for the "overall status" section (requirement 5: original vs mirror per bot).
const MIRROR_OF = {
  intraday: 'intraday_mirror', scalp: 'scalp_mirror', scalp_wide: 'scalp_wide_mirror',
  exhaustion_only: 'exhaustion_only_mirror', trend_smc: 'trend_smc_mirror',
  mcx_gold: 'mcx_gold_mirror', mcx_crude: 'mcx_crude_mirror',
  ccy_usdinr: 'ccy_usdinr_mirror', ccy_eurinr: 'ccy_eurinr_mirror',
  ccy_gbpinr: 'ccy_gbpinr_mirror', ccy_jpyinr: 'ccy_jpyinr_mirror',
};

async function ownTableRows(ctx, bot, status) {
  const { pool } = ctx;
  if (pool) {
    try {
      const { rows } = await pool.query(`SELECT * FROM ${bot}_trades WHERE status = $1 ORDER BY id`, [status]);
      return rows.map((r) => castNumericColumns(r, NUMERIC_COLS));
    } catch (e) { return []; } // table not there yet (bot disabled / fresh database) - empty, never an error
  }
  const store = ctx[OWN_TABLE_BOTS[bot]];
  if (!store) return [];
  try {
    if (status === 'open') return store.allOpenTrades ? await store.allOpenTrades() : [];
    return await store.closedTrades();
  } catch (e) { return []; }
}

/** Every bot's trades of one status ('open' | 'closed'), keyed by bot name - see docs/BOTS.md for the full bot list. */
async function tradesByBot(ctx, status) {
  const { store: mainStore } = ctx;
  let intraday; let scalp; let scalp_wide;
  if (status === 'open') {
    const [nse, crypto] = await Promise.all([mainStore.openTrades('nse'), mainStore.openTrades('crypto')]);
    intraday = [...nse, ...crypto];
    [scalp, scalp_wide] = await Promise.all([mainStore.openTrades('crypto_scalp'), mainStore.openTrades('crypto_wide_scalp')]);
  } else {
    [intraday, scalp, scalp_wide] = await Promise.all([
      mainStore.closedTrades(null), mainStore.closedTrades('crypto_scalp'), mainStore.closedTrades('crypto_wide_scalp'),
    ]);
  }
  const ownNames = Object.keys(OWN_TABLE_BOTS);
  const ownRows = await Promise.all(ownNames.map((b) => ownTableRows(ctx, b, status)));
  return { intraday, scalp, scalp_wide, ...Object.fromEntries(ownNames.map((b, i) => [b, ownRows[i]])) };
}

const closedTradesByBot = (ctx) => tradesByBot(ctx, 'closed');
const openTradesByBot = (ctx) => tradesByBot(ctx, 'open');

module.exports = { closedTradesByBot, openTradesByBot, MIRROR_OF, NUMERIC_COLS, OWN_TABLE_BOTS };
