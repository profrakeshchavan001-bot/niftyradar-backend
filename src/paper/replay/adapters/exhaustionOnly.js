'use strict';
// Adapter for src/paper/bots/exhaustion_only/ (CC3), which already follows docs/BOT-INTERFACE.md's pure
// decide(candles, context) / evaluateExit({trade, candles}) / settle({trade, exitPrice, cfg, fxRate}) shape.
// Imports that bot's own engine.js unchanged; this file only shapes the replay windows and context.
const { decide, evaluateExit, settle } = require('../../bots/exhaustion_only/engine');
const { EXHAUSTION_ONLY_DEFAULTS } = require('../../bots/exhaustion_only/config');
const { MARKET } = require('../../bots/exhaustion_only/bot');
const { buildContext: liveBuildContext, aggregate } = require('../../../../paperbot/engine');
const { istDayStart } = require('../../../../paperbot/time');
const { replayDecideBot } = require('../simulator');

const FIVE_MIN = 5 * 60000;

// context shape decide() reads: { vwap, c1h, c15, nowMs, cfg } (see engine.js's own comment).
function buildContext(candles, now, cfg) {
  const ctx = liveBuildContext(candles, istDayStart(now));
  return { vwap: ctx.vwap, c15: aggregate(candles), c1h: aggregate(candles, FIVE_MIN, 3600000), nowMs: now, cfg };
}

function replayExhaustionOnly({ symbol, candles5m, cfg = EXHAUSTION_ONLY_DEFAULTS, fxRate = 88 }) {
  return replayDecideBot({
    symbol, candles: candles5m, intervalMs: FIVE_MIN, decide, buildContext, evaluateExitFn: evaluateExit, settleFn: settle,
    cfg, fxRate, minCandles: Math.max(cfg.min_candles_5m, 8), window: 330,
  });
}

module.exports = { replayExhaustionOnly, buildContext, decide, evaluateExit, settle, MARKET, EXHAUSTION_ONLY_DEFAULTS, FIVE_MIN };
