'use strict';
// EMA crossover confirmation (CC2 overnight item 5): "a fresh cross with the
// trade is a strong confirmation, a cross against is a warning. It is never
// treated as certain." Pure functions, no I/O.
const { ema } = require('./indicators');

// Whether the fast EMA is above/below/level with the slow EMA, and whether
// that side just changed between the last two closes (a "fresh" cross).
// Returns null when there are not enough candles to compute both EMAs twice.
function emaCrossState(candles, fastN, slowN) {
  if (!candles || candles.length < slowN + 1) return null;
  const closes = candles.map((k) => k.c);
  const fastNow = ema(closes, fastN);
  const slowNow = ema(closes, slowN);
  const fastPrev = ema(closes.slice(0, -1), fastN);
  const slowPrev = ema(closes.slice(0, -1), slowN);
  if ([fastNow, slowNow, fastPrev, slowPrev].some((x) => x == null)) return null;
  const sideOf = (f, s) => (f > s ? 'up' : f < s ? 'down' : 'flat');
  const side = sideOf(fastNow, slowNow);
  const prevSide = sideOf(fastPrev, slowPrev);
  return { side, fresh: side !== prevSide && side !== 'flat', fast: fastNow, slow: slowNow };
}

// One label for storage (`ema_cross` on paper_trades / paper_skips):
//  - 'unknown'           not enough 5-min candles to say anything (never guessed)
//  - 'fresh_with'         the 5-min EMA9/21 just crossed IN the trade's direction - strong confirmation
//  - 'fresh_against'      the 5-min EMA9/21 just crossed AGAINST the trade's direction - a warning
//  - 'fresh_flat'         the 5-min cross just happened but the EMAs are exactly level (rare)
//  - 'confirmed_with'     no fresh 5-min cross, but more of {5m, 15m, 1h} agree with the direction than disagree
//  - 'confirmed_against'  the mirror of the above
//  - 'mixed'              no fresh cross and no majority either way
// `direction` is 'up' or 'down' (the convention already used by patterns/trendOf/decideEntry).
// 15m/1h use EMA20/50; a market/feed that cannot supply one of those timeframes
// still gets an answer from the 5-min timeframe alone - never a hard failure.
function classifyEmaCross({ direction, c5, c15 = null, c1h = null, fast5 = 9, slow5 = 21, fast15 = 20, slow15 = 50 }) {
  const tf5 = emaCrossState(c5, fast5, slow5);
  if (!tf5) return 'unknown';
  const tf15 = emaCrossState(c15, fast15, slow15);
  const tf1h = emaCrossState(c1h, fast15, slow15);
  const withDir = (s) => !!s && s.side === direction;
  const againstDir = (s) => !!s && s.side !== direction && s.side !== 'flat';
  if (tf5.fresh) return withDir(tf5) ? 'fresh_with' : againstDir(tf5) ? 'fresh_against' : 'fresh_flat';
  const states = [tf5, tf15, tf1h].filter(Boolean);
  const withCount = states.filter(withDir).length;
  const againstCount = states.filter(againstDir).length;
  if (withCount > againstCount) return 'confirmed_with';
  if (againstCount > withCount) return 'confirmed_against';
  return 'mixed';
}

module.exports = { emaCrossState, classifyEmaCross };
