'use strict';
// confluence (Bot A) rules. Stored in the main paperbot paper_config table under key "confluence" (the
// table wins, the owner can change a rule without a deploy) - same convention every other bot's config.js
// in this repo already uses (e.g. src/paper/bots/exhaustion_only/config.js).
const { merge } = require('../../../../paperbot/config');

const CONFLUENCE_DEFAULTS = {
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], // Binance public klines, 5-minute candles
  capital_usdt: 1000, // own virtual balance, independent of every other bot
  risk_pct: 2,
  min_candles_5m: 40,
  max_candle_age_min: 10, // newest closed 5-min candle may be this old (2 candles)
  atr_n: 14,
  atr_mult: 0.25, // stop cushion beyond the order block / sweep: this x ATR14(5m)
  ob_look: 60, ob_impulse: 2, // order-block detector window/impulse (paperbot/patterns.js orderBlock())
  sweep_swing: 10, // liquidity-sweep detector lookback (paperbot/patterns.js liquiditySweep())
  target_margin_pct: 0.1, // target sits this % before the obstacle level
  min_rr: 1.5, // reward / risk AFTER costs - never bypassed by pushing the target out further
  fee_pct_per_side: 0.1,
  slippage_pct: 0.03,
  max_trades_per_day: 6,
  min_trades_for_conclusion: 20,
  usdt_inr_fallback: 88,
};

async function loadConfluenceConfig(store) {
  const rows = await store.getConfig();
  if (!('confluence' in rows) && store.setConfigIfMissing) await store.setConfigIfMissing('confluence', CONFLUENCE_DEFAULTS);
  return merge(CONFLUENCE_DEFAULTS, rows.confluence);
}

module.exports = { CONFLUENCE_DEFAULTS, loadConfluenceConfig };
