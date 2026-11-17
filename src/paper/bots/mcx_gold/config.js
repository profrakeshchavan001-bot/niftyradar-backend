'use strict';
// mcx_gold rules (docs/BOTS.md). Stored in the main paperbot paper_config table under key "mcx_gold" (the
// table wins, the owner can change a rule without a deploy) - same convention src/paper/scalp/config.js uses.
// Shape mirrors SCALP_WIDE_DEFAULTS exactly (src/paper/scalp/config.js): this bot reuses analyseWide() /
// evaluateExit() / settle() from src/paper/scalp/engine.js unchanged, so it needs the same config keys.
//
// Symbol/lot size (owner-approved task note: "confirm against config constants already in repo, else use
// standard MCX lot sizes and log that default clearly"): no GOLD/GOLDM config existed anywhere in this
// repo before this bot. MCX's own published contract specs (not the figures suggested in the task, which
// do not match MCX's real specs) are GOLD = 1 kg (1000 g) per lot and GOLDM (Gold Mini) = 100 g per lot;
// this bot trades GOLDM, the smaller/cheaper-margin contract, lot_size_grams: 100 - logged here and in
// the PR description as the explicit assumption.
//
// Price source (docs/MCX-GOLD-CRUDE.md / PR description): MCX has no free, keyless candle feed wired into
// this repo, so price comes from src/paper/lib/yahooFutures.js's PROXY (COMEX GC=F, USD/troy-oz, converted
// to INR/gram) - NOT the real MCX GOLDM print, which differs by import duty/GST/local premium. qty/premium
// below are therefore INR per GRAM (so sizeNse's `premium x lot` gives the right notional), not per 10 g
// the way MCX itself quotes - this bot's own internal unit, not a display convention.
const { merge } = require('../../../../paperbot/config');

const MCX_GOLD_DEFAULTS = {
  symbol: 'GOLDM',
  yahoo_symbol: 'GC=F', // COMEX gold proxy (see file header)
  lot_size_grams: 100, // MCX GOLDM contract size
  capital_inr: 100000, // own virtual balance, independent of every other bot - no MCX capital config existed before this bot, this is a safe starting default (logged)
  risk_pct: 2,
  min_candles_5m: 30,
  min_candles_15m: 21, // built from the 5-minute candles (E.aggregate) - no native 15m feed for this proxy, same as the crypto scalp_wide bot
  max_candle_age_min: 10,
  pattern_swing: 10,
  target_min_pct: 0.8,
  stop_cap_pct: 1.5,
  min_stop_pct: 0.1,
  atr_mult: 0.5,
  atr_n: 14,
  min_rr: 1.0, // reward/risk AFTER costs; never set below 1.0 (same rule as scalp_wide)
  time_stop_min: 45,
  breakeven_frac: 0.5,
  fee_pct_per_side: 0.05, // MCX brokerage + exchange charges are lower than crypto taker fees; a conservative paper estimate, not a real broker's schedule
  slippage_pct: 0.03,
  min_trades_for_conclusion: 20,
  usdinr_fallback: 88, // used only if the live USDINR rate (src/paper/lib/yahooFutures.js) cannot be read
  // MCX trading holidays (yyyy-mm-dd, IST) - NOT identical to the NSE list (paperbot/config.js DEFAULTS.nse.holidays).
  // OWNER: please verify against the MCX circular and add next year's list. A day with no fresh candle is skipped anyway.
  holidays: ['2026-11-24', '2026-12-25'],
};

async function loadMcxGoldConfig(store) {
  const rows = await store.getConfig();
  if (!('mcx_gold' in rows) && store.setConfigIfMissing) await store.setConfigIfMissing('mcx_gold', MCX_GOLD_DEFAULTS);
  return merge(MCX_GOLD_DEFAULTS, rows.mcx_gold);
}

module.exports = { MCX_GOLD_DEFAULTS, loadMcxGoldConfig };
