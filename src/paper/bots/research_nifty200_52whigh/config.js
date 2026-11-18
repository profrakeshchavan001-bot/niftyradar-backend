'use strict';
// research_nifty200_52whigh (S6 - docs/RESEARCH-STRATEGIES-REPORT.md): own virtual balance, Rs 1,00,000
// split equally across the top-30 picks (same per_stock_capital = capital / top_n convention as
// research/strategies/s6_52week_high.py's backtest).
const RESEARCH_N200_52WH_DEFAULTS = {
  capital_inr: 100000,
  top_n: 30,
};

module.exports = { RESEARCH_N200_52WH_DEFAULTS };
