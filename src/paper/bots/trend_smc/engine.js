'use strict';
// trend_smc (docs/BOTS.md): 5-minute entry, 15-minute/1-hour trend, trades only WITH the trend. Entry is a fresh EMA cross (EMA9/21 on
// 5m, EMA20/50 on 15m) OR a BOS/CHoCH-style retest of an order block or FVG, taken only in discount (longs) or premium (shorts).
// Target = nearest opposite level beyond 1 x ATR14(15m); stop = beyond the order block/swing + 1 x ATR14(15m); reward/risk >= 1.5
// after costs; breakeven at 50%. Pure functions only (docs/BOT-INTERFACE.md): no Date.now(), no network, no database.
const P = require('../../lib/indicators');
const { planTrade } = require('../../lib/levels');
const { emaCrossState } = require('../../lib/emaCross');
const { classifyPremiumDiscount } = require('../../lib/smc/premiumDiscount');
const { orderBlock } = require('../../lib/smc/orderBlocks');
const { fvgRetest } = require('../../lib/smc/fvg');
const { aggregate } = require('../../../../paperbot/engine');
const { simulateExit } = require('../../lib/exitSim');

const r = (x, n = 4) => P.round(x, n);
const costPct = (cfg) => 2 * cfg.fee_pct_per_side + cfg.slippage_pct;

// candles: closed 5-minute candles, oldest first. context: { c15, c1h, nowMs, cfg }.
function decide(candles, context) {
  const cfg = context.cfg;
  if (!candles || candles.length < cfg.min_candles_5m) return { take: false, direction: null, reason: `not enough 5-min candles yet (need ${cfg.min_candles_5m})` };
  const last = candles[candles.length - 1];
  if (context.nowMs - (last.t + 5 * 60000) > cfg.max_candle_age_min * 60000) return { take: false, direction: null, reason: 'no fresh 5-min candle (feed stale)' };
  const c15 = context.c15 && context.c15.length ? context.c15 : aggregate(candles);
  if (c15.length < cfg.min_candles_15m) return { take: false, direction: null, reason: `not enough 15-min candles yet (need ${cfg.min_candles_15m})` };
  const c1h = context.c1h || [];

  // trend: the 15-minute EMA20/50 side; the 1-hour side must not actively disagree when it is known (never guessed when unavailable)
  const trend15 = emaCrossState(c15, 20, 50);
  if (!trend15 || trend15.side === 'flat') return { take: false, direction: null, quiet: true, reason: 'no 15-min trend yet' };
  const trend1h = emaCrossState(c1h, 20, 50);
  if (trend1h && trend1h.side !== 'flat' && trend1h.side !== trend15.side) {
    return { take: false, direction: null, reason: `15-min trend (${trend15.side}) and 1-hour trend (${trend1h.side}) disagree; trading only with both` };
  }
  const trendDir = trend15.side; // 'up' | 'down'

  // entry trigger: a fresh 5-min EMA9/21 cross WITH the trend, or a retest of an order block / FVG (both already encode "break, then retest")
  const cross5 = emaCrossState(candles, 9, 21);
  const ob = orderBlock(candles);
  const fvg = fvgRetest(candles);
  const smcHit = [ob, fvg].find((h) => h && h.direction === trendDir);
  const freshWithTrend = cross5 && cross5.fresh && cross5.side === trendDir;
  if (!freshWithTrend && !smcHit) {
    return { take: false, direction: null, quiet: true, reason: 'no setup' };
  }
  const direction = trendDir;
  const long = direction === 'up';
  const entry = last.c;

  // discount for longs, premium for shorts - equilibrium blocks both (neither cheap nor expensive, no edge claimed)
  const pd = classifyPremiumDiscount(candles);
  if (!pd) return { take: false, direction: null, reason: 'premium/discount zone not available yet' };
  if ((long && pd.zone !== 'discount') || (!long && pd.zone !== 'premium')) {
    return { take: false, direction: null, extra: { patterns: [freshWithTrend ? 'ema_cross' : smcHit.name] }, reason: `price is in ${pd.zone}, not ${long ? 'discount' : 'premium'}; a ${long ? 'long' : 'short'} needs the cheaper/richer side of the range` };
  }

  const patterns = [freshWithTrend ? { name: 'ema_cross', direction, candles: [last], note: `fresh EMA9/21 cross with the ${trendDir} trend` } : smcHit];
  const plan = planTrade({
    entry, direction, patterns, c5: candles, c15, c1h, nowMs: context.nowMs,
    opt: { minRr: 0, atrStopMult: cfg.atr_mult, targetBufferPct: cfg.target_buffer_pct, minLevelDistAtr: cfg.min_level_dist_atr },
  });
  if (!plan.ok) return { take: false, direction: null, reason: plan.reason, extra: { patterns: patterns.map((p) => p.name) } };

  const costs = costPct(cfg);
  const rewardNet = plan.plan.rewardPct - costs;
  const riskNet = plan.plan.riskPct + costs;
  const rr = rewardNet / riskNet;
  if (!(rewardNet > 0) || rr < cfg.min_rr) {
    const shadowPlan = { direction: long ? 'LONG' : 'SHORT', entry_price: entry, sl_price: plan.plan.stop, target_price: plan.plan.target, trigger_t: last.t };
    return { take: false, direction: null, reason: `reward/risk ${r(rr, 2)} after costs is below ${cfg.min_rr} (target ${plan.plan.rewardPct}%, stop ${plan.plan.riskPct}%, costs ${r(costs, 2)}% round trip)`, extra: { patterns: patterns.map((p) => p.name), r_factor: r(rr, 2), shadowPlan } };
  }
  return {
    take: true, direction, entry, stop: plan.plan.stop, target: plan.plan.target, trigger_t: last.t,
    rr: r(rr, 2), stopType: plan.plan.stopType, targetType: plan.plan.targetType, pattern: patterns[0].name, trend15: trendDir, zone: pd.zone,
    basis: `trend_smc ${long ? 'LONG' : 'SHORT'}: ${freshWithTrend ? `fresh EMA9/21 cross with the ${trendDir} 15-min/1h trend` : smcHit.note}, price in the ${pd.zone} zone. `
      + `Target ${plan.plan.target} (${plan.plan.targetType}), stop ${plan.plan.stop} (${plan.plan.stopType}), reward/risk ${r(rr, 2)} after the ${r(costs, 2)}% round-trip cost. Breakeven at 50% of the way to target.`,
  };
}

// Candle-accurate exits (src/paper/lib/exitSim.js), breakeven at 50% (unlike exhaustion_only, which has none).
function evaluateExit({ trade, candles }) {
  const short = trade.direction === 'SHORT';
  const after = candles.filter((k) => k.t > trade.trigger_t);
  const sim = simulateExit({ entry: trade.entry_price, target: trade.target_price, stop: trade.sl_price, short, breakevenAt: 0.5, breakevenDone: !!trade.be_moved, candles: after });
  if (!sim.exit) return { exit: false, action: sim.action, stopActive: sim.stopActive };
  return { exit: true, reason: sim.reason === 'breakeven_stop' ? 'breakeven' : sim.reason, price: sim.price, timeMs: sim.candle.t + 5 * 60000 };
}

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
