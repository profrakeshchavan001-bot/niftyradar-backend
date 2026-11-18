'use strict';
// confluence_nse (GROUP 6): the NSE intraday variant of confluence (Bot A) + confluence_flow (Bot B)'s
// logic, for the NSE F&O universe. Behind a feature flag, default OFF (see register.js). Stored under its
// own "confluence_nse" key in the main paper_config table - same convention as every other bot's config.js.
const { merge } = require('../../../../paperbot/config');

const CONFLUENCE_NSE_DEFAULTS = {
  // A small, liquid starter universe - the owner can widen this via paper_config without a deploy, same
  // as every other bot's symbol list in this repo.
  symbols: ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK'],
  capital_inr: 100000,
  risk_pct: 2,
  min_candles_5m: 40,
  max_candle_age_min: 10,
  atr_n: 14,
  atr_mult: 0.25,
  ob_look: 60, ob_impulse: 2,
  sweep_swing: 10,
  target_margin_pct: 0.1,
  min_rr: 1.5,
  fee_pct_per_side: 0.05, // NSE option brokerage/STT proxy, round-trip modelled the same shape as crypto
  slippage_pct: 0.05,
  max_trades_per_day: 6,
  no_new_entry_after_ist: '15:00',
  force_exit_ist: '15:15',
};

async function loadConfluenceNseConfig(store) {
  const rows = await store.getConfig();
  if (!('confluence_nse' in rows) && store.setConfigIfMissing) await store.setConfigIfMissing('confluence_nse', CONFLUENCE_NSE_DEFAULTS);
  return merge(CONFLUENCE_NSE_DEFAULTS, rows.confluence_nse);
}

module.exports = { CONFLUENCE_NSE_DEFAULTS, loadConfluenceNseConfig };
