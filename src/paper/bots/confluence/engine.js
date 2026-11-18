'use strict';
// confluence (Bot A, docs/CONFLUENCE-BOT.md): a trade is taken only when LOCATION (price sitting at an
// order block or a liquidity sweep - src/paper/lib/levelEngine.js + paperbot/patterns.js) and TRIGGER (a
// directional candle pattern from the existing pattern library) both agree on direction, and the
// stop/target (src/paper/lib/logicalTargets.js) come purely from real chart levels with R:R after costs
// at least 1.5. Pure functions only (docs/BOT-INTERFACE.md): no Date.now(), no network, no database -
// `context` carries everything that would otherwise be read live, so this file is reused unchanged by
// both the live bot (bot.js) and the Group 5 replay/backtest.
const P = require('../../../../paperbot/patterns');
const { aggregate } = require('../../../../paperbot/engine');
const { buildLevelSet } = require('../../lib/levelEngine');
const { planFromLevels } = require('../../lib/logicalTargets');
const { simulateExit } = require('../../lib/exitSim');

const r = (x, n = 4) => P.round(x, n);
// Round-trip cost of a trade as % of entry value: fee on both sides + slippage - the exact same shape as
// src/paper/scalp/config.js's costPct() (the scalp_wide fee+slippage model this task must mirror).
const costPct = (cfg) => 2 * cfg.fee_pct_per_side + cfg.slippage_pct;

// Location hits: price sitting at an order block or a liquidity sweep. Returns the hit plus the zone the
// stop should sit beyond (`basis`: { low, high }).
function locationHits(c, cfg) {
  const out = [];
  const ob = P.orderBlock(c, { look: cfg.ob_look, impulse: cfg.ob_impulse });
  if (ob) out.push({ hit: ob, basis: ob.direction === 'up' ? { low: ob.candles[0].l, high: ob.candles[0].h } : { low: ob.candles[0].l, high: ob.candles[0].h } });
  const sweep = P.liquiditySweep(c, { swing: cfg.sweep_swing });
  if (sweep) out.push({ hit: sweep, basis: { low: sweep.candles[0].l, high: sweep.candles[0].h } });
  return out;
}

// Trigger hits: a directional candle pattern, independent of location (classic reversal/continuation shapes).
function triggerHits(c, ctx) {
  return [P.engulfing(c), P.hammer(c), P.shootingStar(c), P.star(c), P.insideBarBreakout(c), P.exhaustionReversal(c, ctx)].filter(Boolean);
}

/**
 * candles: closed 5-minute candles, oldest first. context: { vwap, c15, c1h, dayStartMs, nowMs, cfg,
 * flow? } - `flow` (optional, set only by confluence_flow's decide wrapper below) is a pre-fetched
 * { direction: 'buy'|'sell'|'neutral', strength } order-flow reading; when present it must agree with the
 * trade direction or the idea is skipped (Bot B's extra gate over Bot A).
 * -> { take: true, direction, entry, stop, target, ... } | { take: false, direction: null, reason, extra? }
 */
function decide(candles, context) {
  const cfg = context.cfg;
  if (!candles || candles.length < cfg.min_candles_5m) return { take: false, direction: null, reason: `not enough 5-min candles yet (need ${cfg.min_candles_5m})` };
  const last = candles[candles.length - 1];
  if (context.nowMs - (last.t + 5 * 60000) > cfg.max_candle_age_min * 60000) return { take: false, direction: null, reason: 'no fresh 5-min candle (feed stale)' };
  if (context.vwap == null) return { take: false, direction: null, reason: 'VWAP not available yet' };

  const locs = locationHits(candles, cfg);
  if (!locs.length) return { take: false, direction: null, quiet: true, reason: 'no order block or liquidity sweep (location)' };
  const trigs = triggerHits(candles, { vwap: context.vwap });
  if (!trigs.length) return { take: false, direction: null, quiet: true, reason: 'no directional candle pattern (trigger)' };

  // location AND trigger must agree on direction - that agreement IS the confluence this bot trades.
  const matches = locs.filter((l) => trigs.some((t) => t.direction === l.hit.direction));
  if (!matches.length) {
    return { take: false, direction: null, reason: `location (${locs.map((l) => `${l.hit.name} ${l.hit.direction}`).join(', ')}) and trigger (${trigs.map((t) => `${t.name} ${t.direction}`).join(', ')}) disagree on direction` };
  }
  const chosen = matches[0];
  const long = chosen.hit.direction === 'up';
  const entry = last.c;

  const atr = P.atr(candles, cfg.atr_n);
  if (!(atr > 0)) return { take: false, direction: null, reason: 'ATR of the 5-min candles is not available' };

  const c15 = context.c15 && context.c15.length ? context.c15 : aggregate(candles);
  const c1h = context.c1h || [];
  const { levels } = buildLevelSet({ c5: candles, c15, c1h, dayStartMs: context.dayStartMs, nowMs: context.nowMs, opt: { look: cfg.ob_look, impulse: cfg.ob_impulse } });
  const costs = costPct(cfg);
  const plan = planFromLevels({ entry, long, entryBasis: chosen.basis, levels, atr, costPct: costs, minRr: cfg.min_rr, marginPct: cfg.target_margin_pct, atrMult: cfg.atr_mult });

  const matchedTrig = trigs.find((t) => t.direction === chosen.hit.direction);
  const patterns = [chosen.hit.name, matchedTrig.name];
  const locationType = `${chosen.hit.name} (${chosen.hit.note})`;

  if (!plan.ok) {
    const shadowPlan = plan.plan ? { direction: long ? 'LONG' : 'SHORT', entry_price: entry, sl_price: plan.plan.stop, target_price: plan.plan.target, trigger_t: last.t } : null;
    return { take: false, direction: null, reason: plan.reason, extra: { patterns, r_factor: plan.plan?.rr ?? null, shadowPlan, locationType } };
  }

  // order-flow agreement gate (Bot B only - context.flow is set exclusively by confluence_flow's wrapper below).
  if (context.flow && context.flow.direction !== 'neutral') {
    const wanted = long ? 'buy' : 'sell';
    if (context.flow.direction !== wanted) {
      const shadowPlan = { direction: long ? 'LONG' : 'SHORT', entry_price: entry, sl_price: plan.plan.stop, target_price: plan.plan.target, trigger_t: last.t };
      return { take: false, direction: null, reason: `order flow disagrees: wanted ${wanted}, flow reads ${context.flow.direction} (strength ${context.flow.strength})`, extra: { patterns, shadowPlan, locationType, flow: context.flow } };
    }
  }

  return {
    take: true, direction: chosen.hit.direction, entry,
    stop: plan.plan.stop, target: plan.plan.target, trigger_t: last.t,
    rr: plan.plan.rr, stopType: `beyond ${chosen.hit.name}`, targetType: plan.plan.targetType, obstacleLevel: plan.plan.obstacleLevel,
    obstaclesOnPath: plan.plan.obstacles, pattern: matchedTrig.name, locationType, patterns,
    flow: context.flow || null,
    basis: `Confluence ${long ? 'LONG' : 'SHORT'}: location ${locationType}; trigger ${matchedTrig.name} (${matchedTrig.note}). `
      + `Target ${plan.plan.target} (${plan.plan.targetType}), stop ${plan.plan.stop} (beyond ${chosen.hit.name}), reward/risk ${plan.plan.rr} after ${r(costs, 2)}% round-trip cost.`
      + (plan.plan.obstacles.length ? ` Path check shortened the target to avoid ${plan.plan.obstacles.map((o) => o.type).join(', ')}.` : '')
      + (context.flow ? ` Order flow: ${context.flow.direction} (strength ${context.flow.strength}).` : ''),
  };
}

// Walks closed 5-minute candles after the trigger candle, candle-accurate (src/paper/lib/exitSim.js); both
// target and stop in one candle = stop (worst case, same convention as every other bot in this repo).
function evaluateExit({ trade, candles, cfg = {} }) {
  const short = trade.direction === 'SHORT';
  const after = candles.filter((k) => k.t > trade.trigger_t);
  const sim = simulateExit({ entry: trade.entry_price, target: trade.target_price, stop: trade.sl_price, short, breakevenAt: cfg.breakeven_frac ?? 0.5, breakevenDone: trade.be_moved, candles: after });
  if (!sim.exit) return { exit: false };
  return { exit: true, reason: sim.reason, price: sim.price, timeMs: sim.candle.t + 5 * 60000 };
}

// Gross/net P&L in USDT and rupees - the exact same shape as src/paper/scalp/engine.js's settle() (the
// scalp_wide fee+slippage model this task must mirror).
function settle({ trade, exitPrice, cfg, fxRate }) {
  const long = trade.direction === 'LONG';
  const entryVal = trade.entry_price * trade.qty;
  const exitVal = exitPrice * trade.qty;
  const gross = (exitPrice - trade.entry_price) * trade.qty * (long ? 1 : -1);
  const cost = (cfg.fee_pct_per_side / 100) * (entryVal + exitVal) + (cfg.slippage_pct / 100) * entryVal;
  const net = gross - cost;
  return { gross_pnl_usdt: r(gross, 6), cost_usdt: r(cost, 6), net_pnl_usdt: r(net, 6), gross_pnl_inr: r(gross * fxRate, 2), pnl_inr: r(net * fxRate, 2) };
}

module.exports = { decide, evaluateExit, settle, locationHits, triggerHits, costPct };
