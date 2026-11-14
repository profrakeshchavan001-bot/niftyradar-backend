'use strict';
// Premium / discount zone: where the latest close sits within the recent
// high-low range, split at 50% (ICT "equilibrium"). CC2 round 2 item 2.
const { round } = require('../indicators');

// `candles`: closed candles, oldest first. `lookback` candles set the range.
// Returns null when there are no candles or the range is zero (flat price).
function classifyPremiumDiscount(candles, lookback = 50) {
  const slice = (candles || []).slice(-lookback);
  if (!slice.length) return null;
  const rangeHigh = Math.max(...slice.map((k) => k.h));
  const rangeLow = Math.min(...slice.map((k) => k.l));
  if (!(rangeHigh > rangeLow)) return null;
  const last = candles[candles.length - 1];
  const mid = (rangeHigh + rangeLow) / 2;
  const pct = round((last.c - rangeLow) / (rangeHigh - rangeLow), 4);
  const zone = last.c > mid ? 'premium' : last.c < mid ? 'discount' : 'equilibrium';
  return { zone, pct, rangeHigh, rangeLow, mid };
}

module.exports = { classifyPremiumDiscount };
