'use strict';
// GROUP 1 (confluence / confluence_flow bots, see docs): composes the EXISTING level-detection libraries
// (src/paper/lib/levels.js, paperbot/cryptoLevels.js, paperbot/patterns.js) into one multi-timeframe level
// set per symbol. No new detection math is added here - this file only wraps/combines what already exists,
// as the task brief asks, so the confluence bots and every other caller share one real-levels source of
// truth instead of re-detecting swings/order blocks/FVGs a second time.
const L = require('./levels');
const P = require('../../../paperbot/patterns');

// Today's high/low from the 5-minute candles (the same convention src/paper/scalp/engine.js already uses
// for "today's high"/"today's low" as a target candidate).
function dayHighLow(c5, dayStartMs) {
  const today = (c5 || []).filter((k) => k.t >= dayStartMs);
  if (!today.length) return [];
  return [
    { price: Math.max(...today.map((k) => k.h)), type: "today's high", side: 'resistance', tf: '5m' },
    { price: Math.min(...today.map((k) => k.l)), type: "today's low", side: 'support', tf: '5m' },
  ];
}

// Equal-highs / equal-lows liquidity pools: 2 or more swing prices within `tolPct`% of each other are
// treated as one pool (a cluster of stops/liquidity resting at "the same" level), at their average price.
function equalLevels(prices, type, side, tf, tolPct = 0.08) {
  const sorted = [...new Set((prices || []).filter((p) => p > 0))].sort((a, b) => a - b);
  const pools = [];
  for (let i = 0; i < sorted.length; i++) {
    const group = [sorted[i]];
    let j = i + 1;
    while (j < sorted.length && ((sorted[j] - sorted[i]) / sorted[i]) * 100 <= tolPct) { group.push(sorted[j]); j += 1; }
    if (group.length >= 2) {
      pools.push({ price: P.round(group.reduce((s, x) => s + x, 0) / group.length, 6), type, side, tf, count: group.length });
    }
  }
  return pools;
}

/**
 * Multi-timeframe level set for one symbol. `c5`/`c15`/`c1h` are closed candles, oldest first (same shape
 * every bot in this repo already uses). Returns every level kind the brief lists:
 *   - support/resistance (swing highs/lows on 5m, 15m, 1h)
 *   - order blocks, fair value gaps (paperbot/cryptoLevels.js, on the 5m candles)
 *   - VWAP (today's 5m session, from paperbot/patterns.js's vwap())
 *   - day high/low
 *   - equal-highs/equal-lows liquidity pools (15m swings)
 *   - previous day/week high/low (paperbot/cryptoLevels.js's previousPeriods, on 1h candles)
 * Every entry traces back to real OHLC the bot already has - nothing here is invented or a fixed %.
 */
function buildLevelSet({ c5 = [], c15 = [], c1h = [], dayStartMs, nowMs = Date.now(), opt = {} }) {
  const sw5 = L.swingLevels(c5, opt.swingK || 2, opt.swingLookback5 || 60);
  const sw15 = L.swingLevels(c15, opt.swingK || 2, opt.swingLookback15 || 40);
  const sw1h = L.swingLevels(c1h, opt.swingK || 2, opt.swingLookback1h || 48);
  const vwap = P.vwap((c5 || []).filter((k) => k.t >= dayStartMs));
  const levels = [
    ...sw5.highs.map((price) => ({ price, type: 'swing high 5m', side: 'resistance', tf: '5m' })),
    ...sw5.lows.map((price) => ({ price, type: 'swing low 5m', side: 'support', tf: '5m' })),
    ...sw15.highs.map((price) => ({ price, type: 'swing high 15m', side: 'resistance', tf: '15m' })),
    ...sw15.lows.map((price) => ({ price, type: 'swing low 15m', side: 'support', tf: '15m' })),
    ...sw1h.highs.map((price) => ({ price, type: 'swing high 1h', side: 'resistance', tf: '1h' })),
    ...sw1h.lows.map((price) => ({ price, type: 'swing low 1h', side: 'support', tf: '1h' })),
    ...L.orderBlockLevels(c5, opt).map((l) => ({ ...l, tf: '5m' })),
    ...L.fvgLevels(c5, opt).map((l) => ({ ...l, tf: '5m' })),
    ...L.previousPeriods(c1h, nowMs).map((l) => ({ ...l, side: /high/.test(l.type) ? 'resistance' : 'support', tf: '1h' })),
    ...dayHighLow(c5, dayStartMs),
    ...equalLevels(sw15.highs, 'equal highs liquidity pool 15m', 'resistance', '15m'),
    ...equalLevels(sw15.lows, 'equal lows liquidity pool 15m', 'support', '15m'),
  ].filter((l) => l.price > 0);
  return { levels, vwap, swings: { sw5, sw15, sw1h } };
}

module.exports = { buildLevelSet, dayHighLow, equalLevels };
