'use strict';
// Replay adapter for src/paper/bots/confluence/ (Bot A, GROUP 5). Bot A's own engine.js already follows
// docs/BOT-INTERFACE.md's pure decide(candles, context) / evaluateExit / settle shape, so this file only
// shapes the replay windows and context the same way src/paper/replay/adapters/exhaustionOnly.js does for
// exhaustion_only - no new simulation logic, reuses simulator.js's replayDecideBot() unchanged.
//
// confluence_flow (Bot B) has NO adapter here and cannot be replayed: its decide() needs a live order-flow
// reading (bid/ask depth + recent trades), and this repo keeps no historical order-book data - only
// candles are stored for replay (see src/paper/replay/store.js's replay_candles table). Documented in
// scripts/confluenceReplay.js's own output and docs/CONFLUENCE-BOT.md.
const { decide, evaluateExit, settle } = require('../../bots/confluence/engine');
const { CONFLUENCE_DEFAULTS } = require('../../bots/confluence/config');
const { MARKET } = require('../../bots/confluence/bot');
const { buildContext: liveBuildContext, aggregate } = require('../../../../paperbot/engine');
const { istDayStart } = require('../../../../paperbot/time');
const { replayDecideBot } = require('../simulator');

const FIVE_MIN = 5 * 60000;

// context shape decide() reads: { vwap, c1h, c15, dayStartMs, nowMs, cfg } (see confluence/engine.js's own comment).
function buildContext(candles, now, cfg) {
  const ctx = liveBuildContext(candles, istDayStart(now));
  return { vwap: ctx.vwap, c15: aggregate(candles), c1h: aggregate(candles, FIVE_MIN, 3600000), dayStartMs: istDayStart(now), nowMs: now, cfg };
}

function replayConfluence({ symbol, candles5m, cfg = CONFLUENCE_DEFAULTS, fxRate = 88 }) {
  return replayDecideBot({
    symbol, candles: candles5m, intervalMs: FIVE_MIN, decide, buildContext, evaluateExitFn: evaluateExit, settleFn: settle,
    cfg, fxRate, minCandles: Math.max(cfg.min_candles_5m, 20), window: 330,
  });
}

module.exports = { replayConfluence, buildContext, decide, evaluateExit, settle, MARKET, CONFLUENCE_DEFAULTS, FIVE_MIN };
