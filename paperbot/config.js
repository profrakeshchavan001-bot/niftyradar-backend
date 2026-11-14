'use strict';
// Paper bot defaults. Every value here is also stored in the paper_config
// table (one row per key); the table wins, so the owner can change a rule
// without a deploy. The bot NEVER changes these on its own.

const DEFAULTS = {
  nse: {
    top_n: 5,
    target_pct: 10, // exit when the option is up this much
    stop_pct: 5, // exit when the option is down this much
    force_exit_ist: '15:15',
    no_new_entry_after_ist: '15:00',
    max_trades_per_day: 5,
    capital_inr: 100000,
    risk_pct: 2,
    sim_delta: 0.5, // used only when no real option price is available
    sim_premium_pct: 2.5, // assumed ATM premium as % of spot, simulated trades only
    min_candles: 21,
    // NSE trading holidays (yyyy-mm-dd, IST). OWNER: please verify against the
    // NSE circular and add next year's list. A day with no fresh candle is
    // skipped anyway.
    holidays: ['2026-11-24', '2026-12-25'],
  },
  crypto: {
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    target_pct: 2, // on the underlying
    stop_pct: 1,
    max_trades_per_day: 6,
    capital_usdt: 1000,
    risk_pct: 2,
    min_momentum_score: 1,
    min_candles: 21,
    usdt_inr_fallback: 88, // used only if the live USDT/INR rate cannot be read; flagged on the trade
  },
  patterns: { lookback: 6, minTrend: 4, smallBodyRatio: 0.5, swing: 10 },
  learning: { min_trades_for_conclusion: 20 },
};

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], v);
    else if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

// Reads the config rows from the store and lays them over the defaults.
// Missing rows are created from the defaults (first run).
async function loadConfig(store) {
  const rows = await store.getConfig();
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in rows)) await store.setConfigIfMissing(key, DEFAULTS[key]);
  }
  return merge(DEFAULTS, rows);
}

module.exports = { DEFAULTS, loadConfig, merge };
