'use strict';
// Scalp rules (docs/SCALP.md). Stored in paper_config under the key "scalp" (the table wins, the owner can change a rule without a deploy;
// the bot NEVER changes it by itself). PAPER ONLY.
const { merge } = require('../../../paperbot/config');

const SCALP_DEFAULTS = {
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], // Binance public 1-minute klines
  capital_usdt: 1000, // separate virtual balance for scalps (the intraday bot's balance is not touched)
  risk_pct: 2,
  min_candles_1m: 30, // closed 1-minute candles needed
  min_candles_5m: 21, // closed 5-minute candles needed (trend, VWAP, levels)
  max_candle_age_min: 2, // newest closed 1-minute candle may be this old
  pattern_swing: 10, // candles looked back by the liquidity sweep
  target_cap_pct: 0.5, // target = min(nearest opposite level - level_margin_pct, this)
  target_min_pct: 0.3, // below this there is no room: skip
  level_margin_pct: 0.1,
  stop_cap_pct: 0.3, // stop beyond the pattern candle + atr_mult x ATR14(1m), never wider than this
  min_stop_pct: 0.05, // a stop tighter than this is noise
  atr_mult: 0.5,
  atr_n: 14,
  min_rr: 1.3, // reward / risk AFTER costs
  time_stop_min: 15,
  breakeven_frac: 0.5, // stop moves to the entry price once the price is this share of the way to the target
  fee_pct_per_side: 0.1, // Binance spot taker fee
  slippage_pct: 0.03, // once per round trip, on the entry value
  min_trades_for_conclusion: 20,
  usdt_inr_fallback: 88,
};

async function loadScalpConfig(store) {
  const rows = await store.getConfig();
  if (!('scalp' in rows) && store.setConfigIfMissing) await store.setConfigIfMissing('scalp', SCALP_DEFAULTS);
  return merge(SCALP_DEFAULTS, rows.scalp);
}

// Round-trip cost of a trade as % of its entry value: fee on both sides + slippage.
const costPct = (cfg) => 2 * cfg.fee_pct_per_side + cfg.slippage_pct;

module.exports = { SCALP_DEFAULTS, loadScalpConfig, costPct };
