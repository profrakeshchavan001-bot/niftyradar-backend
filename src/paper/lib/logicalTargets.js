'use strict';
// GROUP 2 (confluence / confluence_flow bots): stop/target/path-check purely from real chart levels
// (src/paper/lib/levelEngine.js's buildLevelSet). The stop is always just beyond the order block / swing
// the entry is based on; the target is always the first real obstacle in the trade's direction; an
// opposing level sitting between entry and target shortens the target (never moves it further out); and a
// plan whose reward/risk after costs is below the minimum is a SKIP, with a reason - the filter is never
// bypassed by pushing the target out further.
const P = require('../../../paperbot/patterns');

const MIN_RR = 1.5;

// Stop: just beyond the order block/swing zone the entry is based on (`entryBasis`: { low, high } of the
// candles/zone the entry pattern used), with a small ATR cushion so a wick exactly at the level does not
// stop the trade out by a hair. The ATR cushion only ever widens the stop a little - it never touches the target.
function computeStop({ long, entryBasis, atr = 0, atrMult = 0.25 }) {
  if (!entryBasis || !Number.isFinite(entryBasis.low) || !Number.isFinite(entryBasis.high)) return null;
  const beyond = long ? entryBasis.low : entryBasis.high;
  return long ? beyond - atrMult * atr : beyond + atrMult * atr;
}

// The first real obstacle in the trade's direction: the nearest resistance level (long) / support level
// (short) among `levels` (levelEngine.buildLevelSet().levels) that sits beyond the entry.
function firstObstacle({ entry, long, levels }) {
  const side = long ? 'resistance' : 'support';
  const cands = (levels || [])
    .filter((l) => l.side === side && l.price > 0 && (long ? l.price > entry : l.price < entry))
    .sort((a, b) => (long ? a.price - b.price : b.price - a.price));
  return cands.length ? cands[0] : null;
}

// Path check: if an OPPOSING level (same side as the target itself - a resistance level in the way of a
// long, a support level in the way of a short) sits strictly between the entry and the first obstacle,
// the target is shortened to that nearer level instead. Only ever shortens; a level that is at or beyond
// the already-chosen target changes nothing.
function pathCheck({ entry, long, target, levels }) {
  const side = long ? 'resistance' : 'support';
  const between = (levels || []).filter((l) => l.side === side && l.price > 0
    && (long ? l.price > entry && l.price < target.price : l.price < entry && l.price > target.price));
  if (!between.length) return { target, obstacles: [], shortened: false };
  const nearest = between.reduce((best, l) => ((long ? l.price < best.price : l.price > best.price) ? l : best));
  return { target: nearest, obstacles: [nearest], shortened: true };
}

/**
 * Full stop/target/R:R plan for one trade idea, from real levels only, or a SKIP with a plain-words
 * reason. Never moves the target further out to pass the R:R gate - the gate is the only thing allowed to
 * turn the idea down.
 *   entry, long        - the trade's own entry price and direction.
 *   entryBasis         - { low, high }: the order-block / swing / pattern zone the entry is based on (-> stop).
 *   levels             - the full level set, levelEngine.buildLevelSet({...}).levels.
 *   atr, costPct       - ATR for the stop cushion; round-trip cost % (fee + slippage) for R:R after costs.
 *   minRr (default 1.5), marginPct (how far before the level the target sits), atrMult (stop cushion size).
 */
function planFromLevels({ entry, long, entryBasis, levels, atr = 0, costPct = 0, minRr = MIN_RR, marginPct = 0.1, atrMult = 0.25 }) {
  if (!(entry > 0)) return { ok: false, reason: 'no entry price' };
  const stop = computeStop({ long, entryBasis, atr, atrMult });
  if (stop == null || (long ? stop >= entry : stop <= entry)) {
    return { ok: false, reason: 'no order block / swing on the entry side to set a stop beyond' };
  }
  const obstacle = firstObstacle({ entry, long, levels });
  if (!obstacle) return { ok: false, reason: `no ${long ? 'resistance' : 'support'} level ahead to target` };
  const margin = (obstacle.price * marginPct) / 100;
  const rawTarget = { price: long ? obstacle.price - margin : obstacle.price + margin, type: obstacle.type };
  const pc = pathCheck({ entry, long, target: rawTarget, levels });
  const target = pc.shortened ? { price: pc.target.price, type: `${pc.target.type} (path-shortened)` } : rawTarget;
  if (long ? target.price <= entry : target.price >= entry) {
    return { ok: false, reason: 'no room left to the target after the path check', obstacles: pc.obstacles };
  }

  const riskAbs = Math.abs(entry - stop);
  const rewardAbs = Math.abs(target.price - entry);
  const costAbs = entry * (costPct / 100);
  const rewardNet = rewardAbs - costAbs;
  const riskNet = riskAbs + costAbs;
  const rr = riskNet > 0 ? P.round(rewardNet / riskNet, 2) : null;
  const basePlan = {
    stop: P.round(stop, 6), target: P.round(target.price, 6), targetType: target.type, obstacleLevel: obstacle,
    rr, obstacles: pc.obstacles, riskAbs: P.round(riskAbs, 6), rewardAbs: P.round(rewardAbs, 6),
  };
  if (!(rewardNet > 0) || rr == null || rr < minRr) {
    return { ok: false, reason: `reward/risk ${rr ?? 'n/a'} after costs is below ${minRr} (never widened to pass this gate)`, plan: basePlan };
  }
  return { ok: true, plan: basePlan };
}

module.exports = { computeStop, firstObstacle, pathCheck, planFromLevels, MIN_RR };
