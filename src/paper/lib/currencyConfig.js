'use strict';
// Config for the four ccy_* bots (NSE currency futures: USDINR, EURINR, GBPINR, JPYINR). Stored in the
// main paperbot `paper_config` table under its own key per pair ("ccy_usdinr", "ccy_eurinr", ...) - same
// convention as src/paper/scalp/config.js (the table wins; the owner can retune one pair without a
// deploy; the bot never changes it by itself) - so the four pairs are independently tunable, never one
// shared block.
const { merge } = require('../../../paperbot/config');
const { LOT_UNITS } = require('./currencyEngine');

// scalp_wide-style defaults (5-min entry, 15-min trend, VWAP + ATR stop - see src/paper/scalp/config.js's
// SCALP_WIDE_DEFAULTS, which these numbers are copied from unchanged; only the capital/lot-size/currency
// fields below are specific to a rupee-quoted NSE futures contract).
const CCY_WIDE_DEFAULTS = {
  capital_inr: 100000, // own virtual balance per pair, independent of every crypto bot and of each other
  lot_units: LOT_UNITS, // 1 lot = 1000 units of the base currency (USD/EUR/GBP/JPY) - see currencyEngine.js's own comment on the JPYINR simplification
  risk_pct: 2,
  min_candles_5m: 30,
  min_candles_15m: 21,
  max_candle_age_min: 20, // Yahoo FX candles can lag more than Binance's own feed; wider than scalp_wide's crypto 10 min on purpose
  pattern_swing: 10,
  target_min_pct: 0.3, // FX crosses move far less % than crypto in a session; lower than scalp_wide's 0.8% crypto default
  stop_cap_pct: 0.5,
  min_stop_pct: 0.03,
  atr_mult: 0.5,
  atr_n: 14,
  min_rr: 1.0,
  time_stop_min: 60,
  breakeven_frac: 0.5,
  // No cost model yet (same "net == gross" convention the NSE cash bot already uses): both 0 by default.
  // analyseWide()'s own reward/risk-after-costs gate (src/paper/scalp/engine.js) reads these same two
  // fields via costPct(cfg) (src/paper/scalp/config.js), and settleInr()'s exit-side cost
  // (src/paper/lib/currencyEngine.js) reuses that exact same costPct() call - entry and exit always agree.
  fee_pct_per_side: 0,
  slippage_pct: 0,
  min_trades_for_conclusion: 20,
};

async function loadCurrencyConfig(store, pairKey) {
  const rows = await store.getConfig();
  if (!(pairKey in rows) && store.setConfigIfMissing) await store.setConfigIfMissing(pairKey, CCY_WIDE_DEFAULTS);
  return merge(CCY_WIDE_DEFAULTS, rows[pairKey]);
}

module.exports = { CCY_WIDE_DEFAULTS, loadCurrencyConfig };
