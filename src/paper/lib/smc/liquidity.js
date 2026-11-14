'use strict';
// Liquidity pools (equal highs/lows), previous day/week high-low, and sweeps.
// CC2 round 2 item 2. Pure, no I/O. Sweeps and previous-period levels already
// exist (paperbot/patterns.js liquiditySweep, paperbot/cryptoLevels.js
// previousPeriods) - re-exported here under src/paper/lib/smc/ rather than
// rewritten, so there is one SMC namespace without duplicating logic.
const { round, avg } = require('../indicators');
const { previousPeriods } = require('../levels');
const { liquiditySweep } = require('../../../../paperbot/patterns');

// Groups of 2+ highs (or lows) within `tolerancePct` of the first value in
// the group, over the last `look` candles - a cluster of equal highs/lows is
// where stops are expected to sit (a liquidity pool).
function equalHighsLows(candles, opt = {}) {
  const look = opt.look || 30;
  const tolPct = opt.tolerancePct || 0.05;
  const c = (candles || []).slice(-look);
  const cluster = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const pools = [];
    let group = sorted.length ? [sorted[0]] : [];
    for (let i = 1; i < sorted.length; i++) {
      const ref = group[0];
      if (ref > 0 && Math.abs(sorted[i] - ref) / ref * 100 <= tolPct) group.push(sorted[i]);
      else { if (group.length >= 2) pools.push({ price: round(avg(group), 4), touches: group.length }); group = [sorted[i]]; }
    }
    if (group.length >= 2) pools.push({ price: round(avg(group), 4), touches: group.length });
    return pools;
  };
  return { equalHighs: cluster(c.map((k) => k.h)), equalLows: cluster(c.map((k) => k.l)) };
}

module.exports = { equalHighsLows, liquiditySweep, previousPeriods };
