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

module.exports = { analyse, evaluateExit, settle };
