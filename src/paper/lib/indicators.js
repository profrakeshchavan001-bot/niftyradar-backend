'use strict';
// Shared indicator functions for every paper-trading bot (CC2, item 1a).
// Re-exported, not rewritten: the real code still lives in paperbot/patterns.js
// (owned by the original NSE/crypto bot) so behaviour does not change by
// moving it. New bots under src/paper/bots/, src/paper/ops/, src/paper/replay/
// should require this file instead of reaching into paperbot/ directly.
const P = require('../../../paperbot/patterns');

module.exports = {
  ema: P.ema,
  vwap: P.vwap,
  atr: P.atr,
  trendOf: P.trendOf,
  detectPatterns: P.detectPatterns,
  isGreen: P.isGreen,
  isRed: P.isRed,
  body: P.body,
  range: P.range,
  avg: P.avg,
  round: P.round,
};
