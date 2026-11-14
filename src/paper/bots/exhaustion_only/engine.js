'use strict';
// exhaustion_only (docs/BOTS.md): the owner's own rule and NOTHING ELSE. In a falling move (4 or more of the last 6 candles red, price
// below VWAP) a small red candle and then a green candle closing above its high means LONG; the mirror in a rising move means SHORT.
// 5-minute candles, no other pattern, no trend filter. This bot exists to measure that one rule, so decide() must not quietly add a
// second condition (reusing patterns.exhaustionReversal() is exactly this rule and nothing more - see its own comments).
// Pure functions only (docs/BOT-INTERFACE.md): no Date.now(), no network, no database.
const P = require('../../lib/indicators');
const { planTrade } = require('../../lib/levels');
const { aggregate } = require('../../../../paperbot/engine');
const { simulateExit } = require('../../lib/exitSim');
const { exhaustionReversal } = require('../../../../paperbot/patterns');

const r = (x, n = 4) => P.round(x, n);
// Round-trip cost of a trade as % of its entry value: fee on both sides + slippage (same shape as src/paper/scalp/config.js costPct).
const costPct = (cfg) => 2 * cfg.fee_pct_per_side + cfg.slippage_pct;

// candles: closed 5-minute candles, oldest first. context: { vwap, c1h, nowMs, cfg }.
// -> { take: true, direction, entry, stop, target, basis, rr, trigger_t } | { take: false, direction: null, reason?, quiet? }
function decide(candles, context) {
  const cfg = context.cfg;
  if (!candles || candles.length < Math.max(cfg.min_candles_5m, 8)) return { take: false, direction: null, reason: `not enough 5-min candles yet (need ${cfg.min_candles_5m})` };
  const last = candles[candles.length - 1];
  if (context.nowMs - (last.t + 5 * 60000) > cfg.max_candle_age_min * 60000) return { take: false, direction: null, reason: 'no fresh 5-min candle (feed stale)' };
  if (context.vwap == null) return { take: false, direction: null, reason: 'VWAP not available yet' };

  // the rule, exactly - patterns.exhaustionReversal() implements it and nothing else (4+/6 red + below VWAP, or the mirror)
  const exhaustion = exhaustionReversal(candles, { vwap: context.vwap });
  if (!exhaustion) return { take: false, direction: null, quiet: true, reason: 'no setup' };

  const direction = exhaustion.direction; // 'up' | 'down'
  const entry = last.c;
  const c15 = context.c15 && context.c15.length ? context.c15 : aggregate(candles);
  const plan = planTrade({
    entry, direction, patterns: [exhaustion], c5: candles, c15, c1h: context.c1h || [], nowMs: context.nowMs,
    opt: { minRr: 0, atrStopMult: cfg.atr_mult, targetBufferPct: cfg.target_buffer_pct, minLevelDistAtr: 0 },
  });
  if (!plan.ok) return { take: false, direction: null, reason: plan.reason, extra: { patterns: [exhaustion.name] } };

  const costs = costPct(cfg);
  const rewardNet = plan.plan.rewardPct - costs;
  const riskNet = plan.plan.riskPct + costs;
  const rr = rewardNet / riskNet;
  if (!(rewardNet > 0) || rr < cfg.min_rr) {
    // shadow tracking (docs/BOTS.md): the plan was fully worked out, only the reward/risk gate turned it down - a real would-be trade.
    const shadowPlan = { direction: direction === 'up' ? 'LONG' : 'SHORT', entry_price: entry, sl_price: plan.plan.stop, target_price: plan.plan.target, trigger_t: last.t };
    return { take: false, direction: null, reason: `reward/risk ${r(rr, 2)} after costs is below ${cfg.min_rr} (target ${plan.plan.rewardPct}%, stop ${plan.plan.riskPct}%, costs ${r(costs, 2)}% round trip)`, extra: { patterns: [exhaustion.name], r_factor: r(rr, 2), shadowPlan } };
  }
  return {
    take: true, direction, entry, stop: plan.plan.stop, target: plan.plan.target, trigger_t: last.t,
    rr: r(rr, 2), stopType: plan.plan.stopType, targetType: plan.plan.targetType, pattern: exhaustion.name, note: exhaustion.note,
    basis: `Exhaustion-only ${direction === 'up' ? 'LONG' : 'SHORT'}: ${exhaustion.note}. Target ${plan.plan.target} (${plan.plan.targetType}), `
      + `stop ${plan.plan.stop} (${plan.plan.stopType}), reward/risk ${r(rr, 2)} after the ${r(costs, 2)}% round-trip cost. No other pattern, no trend filter - this bot measures that one rule alone.`,
  };
}

// Walks closed 5-minute candles since entry, candle-accurate (src/paper/lib/exitSim.js); both target and stop in one candle = stop (worst case).
// No breakeven, no time stop for this bot (the brief gives it none) - breakevenAt is set absurdly high so it can never fire.
function evaluateExit({ trade, candles }) {
  const short = trade.direction === 'SHORT';
  const after = candles.filter((k) => k.t > trade.trigger_t);
  const sim = simulateExit({ entry: trade.entry_price, target: trade.target_price, stop: trade.sl_price, short, breakevenAt: 1e9, candles: after });
  if (!sim.exit) return { exit: false };
  return { exit: true, reason: sim.reason === 'breakeven_stop' ? 'stop' : sim.reason, price: sim.price, timeMs: sim.candle.t + 5 * 60000 };
}

// Gross and net P&L of a closed trade, in USDT and rupees. Same cost model as the scalp bots.
function settle({ trade, exitPrice, cfg, fxRate }) {
  const long = trade.direction === 'LONG';
  const entryVal = trade.entry_price * trade.qty;
  const exitVal = exitPrice * trade.qty;
  const gross = (exitPrice - trade.entry_price) * trade.qty * (long ? 1 : -1);
  const cost = (cfg.fee_pct_per_side / 100) * (entryVal + exitVal) + (cfg.slippage_pct / 100) * entryVal;
  const net = gross - cost;
  return { gross_pnl_usdt: r(gross, 6), cost_usdt: r(cost, 6), net_pnl_usdt: r(net, 6), gross_pnl_inr: r(gross * fxRate, 2), pnl_inr: r(net * fxRate, 2) };
}

module.exports = { decide, evaluateExit, settle, costPct };
