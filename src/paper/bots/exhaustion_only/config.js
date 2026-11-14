'use strict';
// exhaustion_only rules (docs/BOTS.md). Stored in the main paperbot paper_config table under key "exhaustion_only" (the table wins,
// the owner can change a rule without a deploy; the bot never changes it by itself) - same convention src/paper/scalp/config.js uses.
const { merge } = require('../../../../paperbot/config');

const EXHAUSTION_ONLY_DEFAULTS = {
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], // Binance public klines, 5-minute candles
  capital_usdt: 1000, // own virtual balance, independent of every other bot
  risk_pct: 2,
  min_candles_5m: 30,
  max_candle_age_min: 10, // newest closed 5-min candle may be this old (2 candles)
  atr_mult: 1, // stop beyond the pattern candle + 1 x ATR14 (15-min), via src/paper/lib/levels.js planTrade()
  target_buffer_pct: 0.1, // target = the nearest opposite level, 0.1% before it (same convention as the main crypto bot)
  min_rr: 1.2, // reward / risk AFTER costs
  fee_pct_per_side: 0.1,
  slippage_pct: 0.03,
  min_trades_for_conclusion: 20,
  usdt_inr_fallback: 88,
};

async function loadExhaustionConfig(store) {
  const rows = await store.getConfig();
  if (!('exhaustion_only' in rows) && store.setConfigIfMissing) await store.setConfigIfMissing('exhaustion_only', EXHAUSTION_ONLY_DEFAULTS);
  return merge(EXHAUSTION_ONLY_DEFAULTS, rows.exhaustion_only);
}

module.exports = { EXHAUSTION_ONLY_DEFAULTS, loadExhaustionConfig };
