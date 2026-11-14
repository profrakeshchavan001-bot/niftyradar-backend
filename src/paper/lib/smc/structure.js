'use strict';
// BOS (break of structure) and CHoCH (change of character), CC2 round 2 item 2.
// Pure, no I/O. Uses the prior trend (EXCLUDING the last candle, so the break
// itself never looks at its own outcome) and the most recent swing high/low
// before the last candle.
const { trendOf } = require('../indicators');
const { swingLevels } = require('../levels');

// `candles`: closed candles, oldest first. Returns:
//   { type: 'bos',   direction: 'up'|'down', level }  - continuation: the prior trend's own direction, confirmed
//   { type: 'choch', direction: 'up'|'down', level }  - reversal: breaks structure AGAINST the prior trend
//   { type: null, direction: null }                   - no break this candle
//   null                                               - not enough data to say (never guessed)
function classifyStructureBreak(candles, opt = {}) {
  const trendN = opt.trendN || 20;
  const swingK = opt.swingK || 2;
  const swingLookback = opt.swingLookback || 40;
  if (!candles || candles.length < trendN + 2) return null;
  const last = candles[candles.length - 1];
  const prior = candles.slice(0, -1); // the break must never be computed from its own candle
  const priorTrend = trendOf(prior, trendN);
  if (priorTrend === 'unknown') return null;
  const { highs, lows } = swingLevels(prior, swingK, swingLookback);
  const lastHigh = highs.length ? highs[highs.length - 1] : null;
  const lastLow = lows.length ? lows[lows.length - 1] : null;
  if (priorTrend === 'up' && lastHigh != null && last.c > lastHigh) return { type: 'bos', direction: 'up', level: lastHigh };
  if (priorTrend === 'down' && lastLow != null && last.c < lastLow) return { type: 'bos', direction: 'down', level: lastLow };
  if (priorTrend === 'down' && lastHigh != null && last.c > lastHigh) return { type: 'choch', direction: 'up', level: lastHigh };
  if (priorTrend === 'up' && lastLow != null && last.c < lastLow) return { type: 'choch', direction: 'down', level: lastLow };
  return { type: null, direction: null };
}

module.exports = { classifyStructureBreak };
