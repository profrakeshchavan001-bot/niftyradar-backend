'use strict';
// mcx_crude rules (docs/BOTS.md). Stored in the main paperbot paper_config table under key "mcx_crude" -
// same convention as mcx_gold/config.js and src/paper/scalp/config.js. Shape mirrors SCALP_WIDE_DEFAULTS:
// this bot reuses analyseWide() / evaluateExit() / settle() from src/paper/scalp/engine.js unchanged.
//
// Symbol/lot size: CRUDEOIL's MCX contract spec is 100 barrels per lot - this matches the figure the task
// itself gave, confirmed against MCX's published contract spec (no existing config in this repo).
// lot_size_barrels: 100, logged here and in the PR description.
//
// Price source: same PROXY approach as mcx_gold (see src/paper/lib/yahooFutures.js and mcx_gold/config.js's
// comment) - NYMEX WTI (CL=F, USD/barrel) converted to INR/barrel with the live USDINR rate. NOT the real
// MCX CRUDEOIL print, which MCX itself sources from its own Dubai Mercantile / ICE feed and adjusts for
// duty/GST/premium - this proxy will not match tick-for-tick.
const { merge } = require('../../../../paperbot/config');

const MCX_CRUDE_DEFAULTS = {
  symbol: 'CRUDEOIL',
  yahoo_symbol: 'CL=F', // NYMEX WTI proxy (see file header)
  lot_size_barrels: 100, // MCX CRUDEOIL contract size
  capital_inr: 100000, // own virtual balance, independent of every other bot - safe starting default (logged), no MCX capital config existed before this bot
  risk_pct: 2,
  min_candles_5m: 30,
  min_candles_15m: 21,
  max_candle_age_min: 10,
  pattern_swing: 10,
  target_min_pct: 0.8,
  stop_cap_pct: 1.5,
  min_stop_pct: 0.1,
  atr_mult: 0.5,
  atr_n: 14,
  min_rr: 1.0,
  time_stop_min: 45,
  breakeven_frac: 0.5,
  fee_pct_per_side: 0.05,
  slippage_pct: 0.03,
  min_trades_for_conclusion: 20,
  usdinr_fallback: 88,
  // MCX trading holidays (yyyy-mm-dd, IST) - NOT identical to the NSE list. OWNER: please verify against
  // the MCX circular and add next year's list. A day with no fresh candle is skipped anyway.
  holidays: ['2026-11-24', '2026-12-25'],
};

async function loadMcxCrudeConfig(store) {
  const rows = await store.getConfig();
  if (!('mcx_crude' in rows) && store.setConfigIfMissing) await store.setConfigIfMissing('mcx_crude', MCX_CRUDE_DEFAULTS);
  return merge(MCX_CRUDE_DEFAULTS, rows.mcx_crude);
}

module.exports = { MCX_CRUDE_DEFAULTS, loadMcxCrudeConfig };
