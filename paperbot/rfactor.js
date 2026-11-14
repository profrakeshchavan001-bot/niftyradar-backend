'use strict';
// Real risk-reward R factor (plain-word version: docs/R-FACTOR.md). Pure functions.
//   entry  = current price
//   stop   = the larger of 1 x ATR14 (15-min candles) and the distance to the
//            nearest recent swing low (long) / swing high (short)
//   target = distance to the nearest level on the other side (swing level or
//            previous-day high / low), at most 3 x ATR; 2 x ATR when no level exists
//   R      = target distance / stop distance
const P = require('./patterns');
const { istParts } = require('./time');

// The website's placeholder "R-Factor" (size of the move only). Kept so both
// rankings can be compared later. The website column itself is not changed.
const legacyRf = (pct) => P.round(Math.abs(pct) * 1.8 + 0.5, 2);

// Swing points: a candle whose low is below the lows of `k` candles on each
// side is a swing low; mirror for swing highs. Looks at the last `lookback` candles.
function swingLevels(candles, k = 2, lookback = 40) {
  const c = candles.slice(-lookback);
  const lows = [];
  const highs = [];
  for (let i = k; i < c.length - k; i++) {
    const around = [...c.slice(i - k, i), ...c.slice(i + 1, i + k + 1)];
    if (around.every((x) => c[i].l < x.l)) lows.push(c[i].l);
    if (around.every((x) => c[i].h > x.h)) highs.push(c[i].h);
  }
  return { lows, highs };
}

// High and low of the latest IST day before the day that starts at `dayStartMs`.
function prevDayLevels(candles, dayStartMs) {
  const before = candles.filter((k) => k.t < dayStartMs);
  if (!before.length) return null;
  const day = istParts(before[before.length - 1].t).date;
  const rows = before.filter((k) => istParts(k.t).date === day);
  return { date: day, high: Math.max(...rows.map((k) => k.h)), low: Math.min(...rows.map((k) => k.l)) };
}

function side(entry, atr, stopLevels, targetLevels, isLong, opt) {
  const dist = (lvl) => (isLong ? entry - lvl : lvl - entry);
  const stops = stopLevels.map(dist).filter((d) => d > 0);
  const swingStop = stops.length ? Math.min(...stops) : null;
  const stop = Math.max(atr, swingStop || 0);
  const targets = targetLevels.map((lvl) => -dist(lvl)).filter((d) => d > 0);
  const nearest = targets.length ? Math.min(...targets) : null;
  const target = nearest == null ? opt.fallbackAtr * atr : Math.min(nearest, opt.capAtr * atr);
  return {
    stop: P.round(stop, 4), target: P.round(target, 4), r: P.round(target / stop, 2),
    stopBasis: swingStop != null && swingStop > atr ? 'swing' : 'atr',
    targetBasis: nearest == null ? `no level, ${opt.fallbackAtr} x ATR` : nearest > opt.capAtr * atr ? `capped at ${opt.capAtr} x ATR` : 'level',
  };
}

// R for both directions. `c15` = closed 15-min candles (oldest first),
// `prevDay` = { high, low } or null. Returns null when ATR14 cannot be
// computed (fewer than 15 candles): never guessed.
function rFactor({ entry, c15, prevDay = null, opt = {} }) {
  const o = { capAtr: 3, fallbackAtr: 2, swingK: 2, swingLookback: 40, ...opt };
  if (!(entry > 0) || !c15 || c15.length < 15) return null;
  const atr = P.atr(c15, 14);
  if (!(atr > 0)) return null;
  const { lows, highs } = swingLevels(c15, o.swingK, o.swingLookback);
  const day = prevDay ? [prevDay.high, prevDay.low] : [];
  const long = side(entry, atr, lows, [...highs, ...day], true, o);
  const short = side(entry, atr, highs, [...lows, ...day], false, o);
  const direction = short.r > long.r ? 'down' : 'up';
  return { entry, atr15: P.round(atr, 4), long, short, r: Math.max(long.r, short.r), direction, prevDay: prevDay ? { high: prevDay.high, low: prevDay.low } : null };
}

// Ranks rows of { symbol, price, pct, r } (r from rFactor) by R, best first.
// Every row also gets its legacy value and its place in the legacy (% move) order.
function rankByR(rows, topN = 5, legacyOrder = []) {
  return rows
    .map((x) => ({ ...x, rFactor: x.r.r, legacyRf: legacyRf(x.pct), legacyRank: legacyOrder.indexOf(x.symbol) + 1 || null }))
    .sort((a, b) => b.rFactor - a.rFactor || b.legacyRf - a.legacyRf || a.symbol.localeCompare(b.symbol))
    .map((x, i) => ({ ...x, rRank: i + 1 }))
    .slice(0, topN);
}

// Legacy order: symbols by size of today's % move, biggest first.
function legacyOrderOf(quotes) {
  return (quotes || []).filter((s) => s && s.symbol && Number.isFinite(s.pct))
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct) || a.symbol.localeCompare(b.symbol)).map((s) => s.symbol);
}

module.exports = { legacyRf, swingLevels, prevDayLevels, rFactor, rankByR, legacyOrderOf };
