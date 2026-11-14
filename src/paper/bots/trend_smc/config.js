'use strict';
// trend_smc rules (docs/BOTS.md). Stored in the main paperbot paper_config table under key "trend_smc" - same convention every CC3
// bot uses (the table wins, the owner can change a rule without a deploy; the bot never changes it by itself).
const { merge } = require('../../../../paperbot/config');

const TREND_SMC_DEFAULTS = {
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  capital_usdt: 1000,
  risk_pct: 2,
  min_candles_5m: 30,
  min_candles_15m: 21,
  max_candle_age_min: 10,
  atr_mult: 1, // stop beyond the order block/swing + 1 x ATR14(15m)
  min_level_dist_atr: 1, // target must be at least 1 x ATR14(15m) beyond the entry
  target_buffer_pct: 0.1,
  min_rr: 1.5, // reward / risk AFTER costs
  fee_pct_per_side: 0.1,
  slippage_pct: 0.03,
  min_trades_for_conclusion: 20,
  usdt_inr_fallback: 88,
};

async function loadTrendSmcConfig(store) {
  const rows = await store.getConfig();
  if (!('trend_smc' in rows) && store.setConfigIfMissing) await store.setConfigIfMissing('trend_smc', TREND_SMC_DEFAULTS);
  return merge(TREND_SMC_DEFAULTS, rows.trend_smc);
}

module.exports = { TREND_SMC_DEFAULTS, loadTrendSmcConfig };
