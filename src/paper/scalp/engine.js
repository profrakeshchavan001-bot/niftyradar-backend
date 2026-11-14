'use strict';
// Scalp strategy, pure functions (no network, no clock, no database). PAPER ONLY. Docs: docs/SCALP.md.
//   analyse()       -> entry plan or a plain-words reason for skipping
//   evaluateExit()  -> walks the 1-minute candles after the entry: target, stop, breakeven, time stop
//   settle()        -> gross P&L, costs (fees + slippage), net P&L
const P = require('../../../paperbot/patterns');
const E = require('../../../paperbot/engine');
const R = require('../../../paperbot/rfactor');
const { costPct } = require('./config');

const MIN = 60000;
const r = (x, n = 4) => P.round(x, n);

// Entry decision on closed candles. `c1raw` = 1-minute candles (entry), `c5raw` = 5-minute candles (trend, VWAP, levels).
// -> { ok: true, plan } | { ok: false, reason, quiet } ; quiet = no setup at all (nothing worth logging).
function analyse({ c1raw, c5raw, now, cfg, dayStartMs }) {
  const c1 = E.closedOnly(c1raw, MIN, now);
  const c5 = E.closedOnly(c5raw, 5 * MIN, now);
  if (c1.length < cfg.min_candles_1m) return { ok: false, reason: `not enough 1-min candles yet (need ${cfg.min_candles_1m})` };
  const last = c1[c1.length - 1];
  if (now - (last.t + MIN) > cfg.max_candle_age_min * MIN) return { ok: false, reason: 'no fresh 1-min candle (feed stale)' };
  if (c5.length < cfg.min_candles_5m) return { ok: false, reason: `not enough 5-min candles yet (need ${cfg.min_candles_5m})` };

  const ctx5 = E.buildContext(c5, dayStartMs);
  const trend5 = P.trendOf(c5, 20);
  const ctx = { vwap: ctx5.vwap };
  const hits = [P.exhaustionReversal(c1, ctx), P.engulfing(c1, ctx), P.hammer(c1, ctx), P.shootingStar(c1, ctx), P.liquiditySweep(c1, { swing: cfg.pattern_swing })].filter(Boolean);
  if (!hits.length) return { ok: false, quiet: true, reason: 'no setup' };
  const names = hits.map((h) => h.name);
  const extra = { patterns: names, trigger_t: last.t, trend_state: { ...ctx5, trend5 } };

  // must agree with the 5-minute trend or the VWAP side; the exhaustion reversal is a reversal by design and is exempt (like the intraday rule)
  const agree = hits.filter((h) => h.kind === 'reversal' || trend5 === h.direction || ctx5.vwapSide === h.direction);
  if (!agree.length) return { ok: false, extra, reason: `pattern ${hits.map((h) => `${h.name} (${h.direction})`).join(', ')} is against the 5-min trend (${trend5}) and the VWAP side (${ctx5.vwapSide})` };
  if (new Set(agree.map((h) => h.direction)).size > 1) return { ok: false, extra, reason: `patterns disagree: ${agree.map((h) => `${h.name} (${h.direction})`).join(', ')}` };
  const long = agree[0].direction === 'up';
  const entry = last.c;

  // stop: beyond the pattern candle + 0.5 x ATR14(1m), never wider than the cap
  const atr = P.atr(c1, cfg.atr_n);
  if (!(atr > 0)) return { ok: false, extra, reason: 'ATR of the 1-min candles is not available' };
  const used = agree.flatMap((h) => h.candles);
  const extreme = long ? Math.min(...used.map((k) => k.l)) : Math.max(...used.map((k) => k.h));
  const rawStopPct = (Math.abs(long ? entry - extreme : extreme - entry) + cfg.atr_mult * atr) / entry * 100;
  const stopPct = Math.max(cfg.min_stop_pct, Math.min(rawStopPct, cfg.stop_cap_pct));

  // target: nearest opposite level (5-min swing highs/lows, today's high/low) minus the margin, at most the cap, at least the minimum
  const sw = R.swingLevels(c5, 2, 60);
  const today = c5.filter((k) => k.t >= dayStartMs);
  const above = [...sw.highs, ...(today.length ? [Math.max(...today.map((k) => k.h))] : [])].filter((x) => x > entry * 1.0001);
  const below = [...sw.lows, ...(today.length ? [Math.min(...today.map((k) => k.l))] : [])].filter((x) => x < entry * 0.9999);
  const level = long ? (above.length ? Math.min(...above) : null) : (below.length ? Math.max(...below) : null);
  const levelPct = level == null ? null : Math.abs(level - entry) / entry * 100;
  const targetPct = levelPct == null ? cfg.target_cap_pct : Math.min(levelPct - cfg.level_margin_pct, cfg.target_cap_pct);
  if (targetPct < cfg.target_min_pct) {
    return { ok: false, extra, reason: `only ${r(levelPct, 2)}% of room to the nearest ${long ? 'resistance' : 'support'} ${r(level, 4)}; after leaving ${cfg.level_margin_pct}% the target would be ${r(targetPct, 2)}%, below the ${cfg.target_min_pct}% minimum` };
  }

  // reward / risk after costs
  const costs = costPct(cfg);
  const rewardNet = targetPct - costs;
  const riskNet = stopPct + costs;
  const rr = rewardNet / riskNet;
  if (!(rewardNet > 0) || rr < cfg.min_rr) {
    return { ok: false, extra: { ...extra, r_factor: r(rr, 2) }, reason: `reward/risk ${r(rr, 2)} after costs is below ${cfg.min_rr} (target ${r(targetPct, 2)}%, stop ${r(stopPct, 2)}%, costs ${r(costs, 2)}% round trip)` };
  }
  const sgn = long ? 1 : -1;
  return {
    ok: true,
    plan: {
      direction: agree[0].direction, long, hits: agree, entry, atr, trend5, ctx5, last,
      stopPct: r(stopPct, 4), targetPct: r(targetPct, 4), costPct: r(costs, 4), rr: r(rr, 2), rewardNetPct: r(rewardNet, 4), riskNetPct: r(riskNet, 4),
      stopPrice: r(entry * (1 - sgn * stopPct / 100), 6), targetPrice: r(entry * (1 + sgn * targetPct / 100), 6),
      level: level == null ? null : { price: r(level, 6), pct: r(levelPct, 4) },
    },
  };
}

// Walks the closed 1-minute candles that came after the trigger candle. Worst case first: when one candle touches both stop and target the stop wins.
// -> { exit, reason, price, timeMs, beMoved, favPct, advPct }  (reason: target | stop | breakeven | time)
function evaluateExit({ trade, candles, nowMs, cfg }) {
  const long = trade.direction === 'LONG';
  const entry = trade.entry_price;
  const entryMs = Date.parse(trade.entry_time);
  const deadline = entryMs + cfg.time_stop_min * MIN;
  const half = entry + (trade.target_price - entry) * cfg.breakeven_frac;
  let stop = trade.sl_price;
  let be = false;
  let fav = 0; let adv = 0;
  let lastEnd = null; let lastClose = null;
  const pct = (px) => (long ? px - entry : entry - px) / entry * 100;
  const done = (reason, price, timeMs) => ({ exit: true, reason, price, timeMs, beMoved: be, favPct: r(fav, 3), advPct: r(adv, 3) });
  for (const c of candles) {
    if (c.t < trade.trigger_t + MIN) continue; // only candles after the trigger candle
    if (c.t >= deadline) return done('time', lastClose ?? c.o, lastEnd ?? c.t); // the time stop came before this candle
    const hitStop = long ? c.l <= stop : c.h >= stop;
    const hitTarget = long ? c.h >= trade.target_price : c.l <= trade.target_price;
    fav = Math.max(fav, pct(long ? c.h : c.l)); adv = Math.min(adv, pct(long ? c.l : c.h));
    if (hitStop) return done(be && stop === entry ? 'breakeven' : 'stop', stop, c.t + MIN);
    if (hitTarget) return done('target', trade.target_price, c.t + MIN);
    if (!be && (long ? c.h >= half : c.l <= half)) { be = true; stop = entry; }
    lastEnd = c.t + MIN; lastClose = c.c;
    if (lastEnd >= deadline) return done('time', c.c, lastEnd);
  }
  if (nowMs >= deadline + MIN && lastClose != null) return done('time', lastClose, lastEnd); // feed gap: do not hold past the time stop
  return { exit: false, beMoved: be, favPct: r(fav, 3), advPct: r(adv, 3) };
}

// Gross and net P&L of a closed scalp, in USDT and in rupees. Costs: fee on both sides' value + slippage on the entry value.
function settle({ trade, exitPrice, cfg, fxRate }) {
  const long = trade.direction === 'LONG';
  const entryVal = trade.entry_price * trade.qty;
  const exitVal = exitPrice * trade.qty;
  const gross = (exitPrice - trade.entry_price) * trade.qty * (long ? 1 : -1);
  const cost = (cfg.fee_pct_per_side / 100) * (entryVal + exitVal) + (cfg.slippage_pct / 100) * entryVal;
  const net = gross - cost;
  return { gross_pnl_usdt: r(gross, 6), cost_usdt: r(cost, 6), net_pnl_usdt: r(net, 6), gross_pnl_inr: r(gross * fxRate, 2), pnl_inr: r(net * fxRate, 2) };
}

// scalp_wide entry: same shape as analyse(), but on closed 5-minute candles with the 15-minute candles as trend (native c15raw, else built from c5).
// Target must be the nearest opposite level, and that level must be at least cfg.target_min_pct AND at least 1 x ATR14(5m) away (whichever is larger) -
// otherwise there is no room and the setup is skipped. Stop: beyond the pattern candle + atr_mult x ATR14(5m). Reward/risk after costs >= cfg.min_rr.
function analyseWide({ c5raw, c15raw, now, cfg, dayStartMs }) {
  const FIVE = 5 * MIN; const FIFTEEN = 15 * MIN;
  const c5 = E.closedOnly(c5raw, FIVE, now);
  if (c5.length < cfg.min_candles_5m) return { ok: false, reason: `not enough 5-min candles yet (need ${cfg.min_candles_5m})` };
  const last = c5[c5.length - 1];
  if (now - (last.t + FIVE) > cfg.max_candle_age_min * MIN) return { ok: false, reason: 'no fresh 5-min candle (feed stale)' };
  const c15raw2 = c15raw && c15raw.length ? c15raw : E.aggregate(c5);
  const c15 = E.closedOnly(c15raw2, FIFTEEN, now);
  if (c15.length < cfg.min_candles_15m) return { ok: false, reason: `not enough 15-min candles yet (need ${cfg.min_candles_15m})` };

  const ctx15 = E.buildContext(c5, dayStartMs, c15);
  const trend15 = P.trendOf(c15, 20);
  const ctx = { vwap: ctx15.vwap };
  const hits = [P.exhaustionReversal(c5, ctx), P.engulfing(c5, ctx), P.hammer(c5, ctx), P.shootingStar(c5, ctx), P.liquiditySweep(c5, { swing: cfg.pattern_swing })].filter(Boolean);
  if (!hits.length) return { ok: false, quiet: true, reason: 'no setup' };
  const names = hits.map((h) => h.name);
  const extra = { patterns: names, trigger_t: last.t, trend_state: { ...ctx15, trend15 } };

  // must agree with the 15-minute trend or the VWAP side; the exhaustion reversal is exempt
  const agree = hits.filter((h) => h.kind === 'reversal' || trend15 === h.direction || ctx15.vwapSide === h.direction);
  if (!agree.length) return { ok: false, extra, reason: `pattern ${hits.map((h) => `${h.name} (${h.direction})`).join(', ')} is against the 15-min trend (${trend15}) and the VWAP side (${ctx15.vwapSide})` };
  if (new Set(agree.map((h) => h.direction)).size > 1) return { ok: false, extra, reason: `patterns disagree: ${agree.map((h) => `${h.name} (${h.direction})`).join(', ')}` };
  const long = agree[0].direction === 'up';
  const entry = last.c;

  // stop: beyond the pattern candle + atr_mult x ATR14(5m), never wider than the cap
  const atr = P.atr(c5, cfg.atr_n);
  if (!(atr > 0)) return { ok: false, extra, reason: 'ATR of the 5-min candles is not available' };
  const atrPct = atr / entry * 100;
  const used = agree.flatMap((h) => h.candles);
  const extreme = long ? Math.min(...used.map((k) => k.l)) : Math.max(...used.map((k) => k.h));
  const rawStopPct = (Math.abs(long ? entry - extreme : extreme - entry) + cfg.atr_mult * atr) / entry * 100;
  const stopPct = Math.max(cfg.min_stop_pct, Math.min(rawStopPct, cfg.stop_cap_pct));

  // target: nearest opposite level (5-min swing highs/lows, today's high/low); it must be at least target_min_pct AND 1 x ATR away, whichever is larger
  const sw = R.swingLevels(c5, 2, 60);
  const today = c5.filter((k) => k.t >= dayStartMs);
  const above = [...sw.highs, ...(today.length ? [Math.max(...today.map((k) => k.h))] : [])].filter((x) => x > entry * 1.0001);
  const below = [...sw.lows, ...(today.length ? [Math.min(...today.map((k) => k.l))] : [])].filter((x) => x < entry * 0.9999);
  const level = long ? (above.length ? Math.min(...above) : null) : (below.length ? Math.max(...below) : null);
  if (level == null) return { ok: false, extra, reason: `no ${long ? 'resistance' : 'support'} level in the way; scalp_wide needs one to target` };
  const levelPct = Math.abs(level - entry) / entry * 100;
  const required = Math.max(cfg.target_min_pct, atrPct);
  if (levelPct < required) {
    return { ok: false, extra, reason: `nearest ${long ? 'resistance' : 'support'} ${r(level, 4)} is only ${r(levelPct, 2)}% away, below the ${r(required, 2)}% needed (${cfg.target_min_pct}% minimum, or 1 x ATR ${r(atrPct, 2)}%, whichever is larger)` };
  }
  const targetPct = levelPct; // the target IS the level (no margin held back, unlike the tight scalp); rounded only for display below

  // reward / risk after costs
  const costs = costPct(cfg);
  const rewardNet = targetPct - costs;
  const riskNet = stopPct + costs;
  const rr = rewardNet / riskNet;
  if (!(rewardNet > 0) || rr < cfg.min_rr) {
    return { ok: false, extra: { ...extra, r_factor: r(rr, 2) }, reason: `reward/risk ${r(rr, 2)} after costs is below ${cfg.min_rr} (target ${r(targetPct, 2)}%, stop ${r(stopPct, 2)}%, costs ${r(costs, 2)}% round trip)` };
  }
  const sgn = long ? 1 : -1;
  return {
    ok: true,
    plan: {
      direction: agree[0].direction, long, hits: agree, entry, atr, trend15, ctx15, last,
      stopPct: r(stopPct, 4), targetPct: r(targetPct, 4), costPct: r(costs, 4), rr: r(rr, 2), rewardNetPct: r(rewardNet, 4), riskNetPct: r(riskNet, 4),
      stopPrice: r(entry * (1 - sgn * stopPct / 100), 6), targetPrice: r(entry * (1 + sgn * targetPct / 100), 6),
      level: { price: r(level, 6), pct: r(levelPct, 4) },
    },
  };
}

module.exports = { analyse, analyseWide, evaluateExit, settle };
