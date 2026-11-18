'use strict';
// research_usdinr_trend (S1, USDINR leg - docs/RESEARCH-STRATEGIES-REPORT.md): own virtual balance,
// independent of every other bot in this repo. Rs 1,00,000, same starting capital the backtest used.
const RESEARCH_USDINR_TREND_DEFAULTS = {
  capital_inr: 100000,
  ticker: 'USDINR=X',
  symbol: 'USDINR',
};

module.exports = { RESEARCH_USDINR_TREND_DEFAULTS };
