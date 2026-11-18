'use strict';
// research_btc_momentum (S2 - docs/RESEARCH-STRATEGIES-REPORT.md): own virtual balance, Rs 1,00,000,
// same starting capital the backtest used. Same simplification research/strategies/s2_btc_momentum.py's
// backtest makes: capital is treated as a flat notional against the BTC-USD price (no separate USD/INR
// conversion step) - pnl_inr is therefore an approximation, not a real USD trade converted at a live FX
// rate; logged here rather than silently assumed.
const RESEARCH_BTC_MOMENTUM_DEFAULTS = {
  capital_inr: 100000,
  ticker: 'BTC-USD',
  symbol: 'BTC',
};

module.exports = { RESEARCH_BTC_MOMENTUM_DEFAULTS };
