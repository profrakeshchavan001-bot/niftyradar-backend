'use strict';
// Adapter for the original "intraday crypto" bot (paperbot/bot.js cryptoScan/cryptoMonitor): composes the
// REAL, imported entry pieces (momentum gate + pattern detection + decideEntry from paperbot/engine.js and
// paperbot/patterns.js, level-based target/stop from paperbot/cryptoLevels.js planTrade -- the SAME planTrade
// src/paper/bots/exhaustion_only/ uses, via src/paper/lib/levels.js) into the decide(candles, context) shape
// (docs/BOT-INTERFACE.md), so it can be replayed with the shared replayDecideBot(). Nothing here reimplements
// those functions; it only wires their existing shapes together.
//
// Exit: the live cryptoMonitor checks a single tick price once a minute (paperbot/cryptoLevels.js
// manageTrade), deliberately NOT candle-accurate yet (docs/decisions/CC2.md). Historical data has no ticks,
// and the brief's own rule for every replay adapter is "stop and target checked on each candle's high and
// low, both = stop" -- so this adapter's evaluateExit uses the shared, candle-accurate src/paper/lib/exitSim.js
// simulateExit() instead of manageTrade(). This is a deliberate, documented choice (docs/REPLAY.md), not a
// copy of manageTrade's logic.
//
// Costs: the live crypto bot's own P&L has NO fee/slippage deduction at all (paperbot/bot.js cryptoMonitor).
// This replay applies the brief's uniform cost model (0.1%/side + 0.03% slippage) on every adapter so the
// report always shows the honest, after-cost picture -- documented in docs/REPLAY.md, not silently added.
const E = require('../../../../paperbot/engine');
const P = require('../../../../paperbot/patterns');
const { DEFAULTS } = require('../../../../paperbot/config');
const { planTrade } = require('../../lib/levels');
const { simulateExit } = require('../../lib/exitSim');
const { istDayStart } = require('../../../../paperbot/time');
const { replayDecideBot } = require('../simulator');

const FIVE_MIN = 5 * 60000;
const MARKET = 'crypto'; // same market key paperbot/bot.js uses for this bot's live trades

// The live crypto bot has no fee/slippage fields of its own (see header); the replay adds the brief's
// uniform cost model on top of the real paperbot/config.js DEFAULTS.crypto + DEFAULTS.patterns.
const INTRADAY_CRYPTO_DEFAULTS = {
  ...DEFAULTS.crypto,
  patternOpt: DEFAULTS.patterns,
  fee_pct_per_side: 0.1,
  slippage_pct: 0.03,
  min_trades_for_conclusion: 20,
};

function buildContext(candles, now, cfg) {
  const ctx = E.buildContext(candles, istDayStart(now), E.aggregate(candles));
  return { ctx, nowMs: now, cfg };
}

// candles: closed 5-minute candles, oldest first (same stream paperbot/bot.js's crypto.candles() returns).
function decide(candles, context) {
  const { cfg, ctx, nowMs } = context;
  if (candles.length < cfg.min_candles) return { take: false, direction: null, reason: `not enough 5-min candles yet (need ${cfg.min_candles})` };
  const m = E.momentumScore(candles);
  if (!m || m.score < cfg.min_momentum_score) return { take: false, direction: null, quiet: true, reason: `momentum score ${m ? m.score : null} is below ${cfg.min_momentum_score}` };
  const patterns = P.detectPatterns(candles, ctx, cfg.patternOpt);
  if (!patterns.length) return { take: false, direction: null, quiet: true, reason: 'no setup' };
  const decision = E.decideEntry(patterns, ctx);
  if (!decision.enter) return { take: false, direction: null, reason: decision.reason, extra: { patterns: patterns.map((p) => p.name) } };
  const last = candles[candles.length - 1];
  const entry = ctx.price;
  const c1h = E.aggregate(candles, FIVE_MIN, 3600000);
  const planned = planTrade({ entry, direction: decision.direction, patterns: decision.patterns, c5: candles, c15: E.aggregate(candles), c1h, nowMs, opt: cfg.levels });
  if (!planned.ok) return { take: false, direction: null, reason: planned.reason, extra: { patterns: patterns.map((p) => p.name) } };
  const plan = planned.plan;
  const names = decision.patterns.map((p) => p.name);
  return {
    take: true, direction: decision.direction, entry, stop: plan.stop, target: plan.target, trigger_t: last.t, rr: plan.rr, patterns: names,
    basis: `Intraday crypto ${decision.direction === 'up' ? 'LONG' : 'SHORT'}: momentum ${m.score}, ${names.join(', ')}. `
      + `Target ${plan.target} (${plan.targetType}), stop ${plan.stop} (${plan.stopType}), reward/risk ${plan.rr}.`,
  };
}

// Candle-accurate exit (replay convention; see header). No breakeven data stored on a plain decide() plan,
// so this uses the config's breakeven_at the same as the live bot's level-based exits.
function evaluateExit({ trade, candles }, cfg = INTRADAY_CRYPTO_DEFAULTS) {
  const short = trade.direction === 'SHORT';
  const sim = simulateExit({ entry: trade.entry_price, target: trade.target_price, stop: trade.sl_price, short, breakevenAt: cfg.breakeven_at ?? 0.5, candles });
  if (!sim.exit) return { exit: false };
  return { exit: true, reason: sim.reason, price: sim.price, timeMs: sim.candle.t + FIVE_MIN };
}

// Same cost model as every other adapter here (fee both sides + slippage on entry value); see header re: costs.
function settle({ trade, exitPrice, cfg, fxRate }) {
  const long = trade.direction === 'LONG';
  const entryVal = trade.entry_price * trade.qty;
  const exitVal = exitPrice * trade.qty;
  const gross = (exitPrice - trade.entry_price) * trade.qty * (long ? 1 : -1);
  const cost = (cfg.fee_pct_per_side / 100) * (entryVal + exitVal) + (cfg.slippage_pct / 100) * entryVal;
  const net = gross - cost;
  const r = (x, n) => Math.round(x * 10 ** n) / 10 ** n;
  return { gross_pnl_usdt: r(gross, 6), cost_usdt: r(cost, 6), net_pnl_usdt: r(net, 6), gross_pnl_inr: r(gross * fxRate, 2), pnl_inr: r(net * fxRate, 2) };
}

function replayIntradayCrypto({ symbol, candles5m, cfg = INTRADAY_CRYPTO_DEFAULTS, fxRate = 88 }) {
  return replayDecideBot({
    symbol, candles: candles5m, intervalMs: FIVE_MIN, decide, buildContext,
    evaluateExitFn: (args) => evaluateExit(args, cfg), settleFn: settle, cfg, fxRate, minCandles: Math.max(cfg.min_candles, 21), window: 330,
  });
}

module.exports = { replayIntradayCrypto, decide, evaluateExit, settle, buildContext, MARKET, INTRADAY_CRYPTO_DEFAULTS };
