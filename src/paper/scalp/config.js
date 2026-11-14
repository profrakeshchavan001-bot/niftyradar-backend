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
  min_rr: 1.0, // reward / risk AFTER costs; 1.3 skipped nearly everything (round-trip cost 0.23%), 1.0 is the floor: a trade that cannot pay its own costs is never logical, so this is never set below 1.0
  time_stop_min: 15,
  breakeven_frac: 0.5, // stop moves to the entry price once the price is this share of the way to the target
  fee_pct_per_side: 0.1, // Binance spot taker fee
  slippage_pct: 0.03, // once per round trip, on the entry value
  min_trades_for_conclusion: 20,
  usdt_inr_fallback: 88,
};

// scalp_wide: same coins and costs, slower (5-min entry, 15-min trend), wider target/stop/time stop. docs/SCALP.md "Scalp wide".
const SCALP_WIDE_DEFAULTS = {
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  capital_usdt: 1000, // own virtual balance, separate from scalp and intraday
  risk_pct: 2,
  min_candles_5m: 30, // closed 5-minute candles needed (entry, ATR, levels, VWAP)
  min_candles_15m: 21, // closed 15-minute candles needed (trend); built from the 5-minute candles when no native feed
  max_candle_age_min: 10, // newest closed 5-min candle may be this old (2 candles)
  pattern_swing: 10,
  target_min_pct: 0.8, // the target level must be at least this far away AND at least 1 x ATR14(5m) away, whichever is larger; otherwise skip (no room)
  stop_cap_pct: 1.5, // stop beyond the pattern candle + 0.5 x ATR14(5m), never wider than this
  min_stop_pct: 0.1, // a stop tighter than this is noise
  atr_mult: 0.5,
  atr_n: 14,
  min_rr: 1.0, // reward / risk AFTER costs; never set below 1.0 (a trade that cannot pay its costs is not logical)
  time_stop_min: 45,
  breakeven_frac: 0.5,
  fee_pct_per_side: 0.1,
  slippage_pct: 0.03,
  min_trades_for_conclusion: 20,
  usdt_inr_fallback: 88,
};

async function loadScalpConfig(store) {
  const rows = await store.getConfig();
  if (!('scalp' in rows) && store.setConfigIfMissing) await store.setConfigIfMissing('scalp', SCALP_DEFAULTS);
  return merge(SCALP_DEFAULTS, rows.scalp);
}

async function loadScalpWideConfig(store) {
  const rows = await store.getConfig();
  if (!('scalp_wide' in rows) && store.setConfigIfMissing) await store.setConfigIfMissing('scalp_wide', SCALP_WIDE_DEFAULTS);
  return merge(SCALP_WIDE_DEFAULTS, rows.scalp_wide);
}

// Round-trip cost of a trade as % of its entry value: fee on both sides + slippage.
const costPct = (cfg) => 2 * cfg.fee_pct_per_side + cfg.slippage_pct;

module.exports = { SCALP_DEFAULTS, SCALP_WIDE_DEFAULTS, loadScalpConfig, loadScalpWideConfig, costPct };
