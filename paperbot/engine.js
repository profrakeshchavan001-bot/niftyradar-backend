'use strict';
// Paper bot: ranking, entry/exit rules, sizing and wording. Pure functions.
// PAPER ONLY: nothing in this folder can place an order anywhere.
const P = require('./patterns');

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// R-factor (proxy v1). The backend has no R-factor code of its own, so the
// bot uses a relative-move factor built from the live quotes it already has:
//   R = |stock % change today| / median |% change| of the whole basket.
// R = 2 means the stock is moving twice as much as the typical basket stock.
function rankRFactor(stocks, topN = 5) {
  const rows = (stocks || []).filter((s) => s && s.symbol && Number.isFinite(s.pct) && s.price > 0);
  const base = median(rows.map((s) => Math.abs(s.pct)));
  if (!(base > 0)) return [];
  return rows
    .map((s) => ({ symbol: s.symbol, price: s.price, pct: s.pct, rFactor: P.round(Math.abs(s.pct) / base, 2) }))
    .sort((a, b) => b.rFactor - a.rFactor || a.symbol.localeCompare(b.symbol))
    .slice(0, topN);
}

// Crypto momentum score (used in place of R-factor):
//   0.4 x volume spike   (last volume / average of the 20 before it)
// + 0.3 x range expansion (last high-low / average of the 20 before it)
// + 0.3 x trend strength  (|close - EMA20| / ATR14)
// About 1 = an ordinary candle. Returns null when there is too little data.
function momentumScore(candles) {
  if (!candles || candles.length < 21) return null;
  const last = candles[candles.length - 1];
  const prev = candles.slice(-21, -1);
  const avgVol = P.avg(prev.map((k) => k.v || 0));
  const avgRange = P.avg(prev.map(P.range));
  const e = P.ema(candles.map((k) => k.c), 20);
  const a = P.atr(candles, 14);
  if (!(avgVol > 0) || !(avgRange > 0) || !(a > 0) || e == null) return null;
  const vol = (last.v || 0) / avgVol;
  const rng = P.range(last) / avgRange;
  const trend = Math.abs(last.c - e) / a;
  return { score: P.round(0.4 * vol + 0.3 * rng + 0.3 * trend, 2), volumeSpike: P.round(vol, 2), rangeExpansion: P.round(rng, 2), trendStrength: P.round(trend, 2) };
}

// Keeps only candles that have fully closed at `nowMs`.
function closedOnly(candles, intervalMs, nowMs) {
  return (candles || []).filter((k) => k.t + intervalMs <= nowMs);
}

// 5-minute candles -> 15-minute candles (buckets on the clock quarter hour,
// which is where both the NSE 09:15 open and Binance candles line up).
// Only complete buckets (three 5-minute candles) are returned.
function aggregate(candles, fromMs = 300000, toMs = 900000) {
  const need = toMs / fromMs;
  const map = new Map();
  for (const k of candles) {
    const key = Math.floor(k.t / toMs) * toMs;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(k);
  }
  const out = [];
  for (const [t, ks] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
    if (ks.length !== need) continue;
    out.push({ t, o: ks[0].o, h: Math.max(...ks.map((k) => k.h)), l: Math.min(...ks.map((k) => k.l)), c: ks[ks.length - 1].c, v: ks.reduce((s, k) => s + (k.v || 0), 0) });
  }
  return out;
}

// Trend context from closed 5-minute candles: 15-minute trend, today's VWAP,
// EMA20 of the 5-minute closes and which side of VWAP the price is on.
function buildContext(c5, dayStartMs) {
  const today = c5.filter((k) => k.t >= dayStartMs);
  const last = c5[c5.length - 1];
  const v = today.length ? P.vwap(today) : null;
  const e = P.ema(c5.map((k) => k.c), 20);
  return {
    price: last ? last.c : null,
    vwap: v == null ? null : P.round(v, 4),
    ema20: e == null ? null : P.round(e, 4),
    trend15: P.trendOf(aggregate(c5), 20),
    vwapSide: v == null || !last ? 'unknown' : last.c > v ? 'up' : last.c < v ? 'down' : 'flat',
    emaSide: e == null || !last ? 'unknown' : last.c > e ? 'up' : last.c < e ? 'down' : 'flat',
  };
}

// ENTRY rule: at least one pattern fires and its direction agrees with BOTH
// the 15-minute trend and the VWAP side. The exhaustion reversal is allowed
// against the trend by design. Patterns pointing both ways = no trade.
function decideEntry(patterns, ctx) {
  if (!patterns.length) return { enter: false, reason: 'no pattern' };
  const ok = patterns.filter((p) => p.kind === 'reversal' || (ctx.trend15 === p.direction && ctx.vwapSide === p.direction));
  if (!ok.length) {
    return { enter: false, reason: `pattern ${patterns.map((p) => `${p.name} (${p.direction})`).join(', ')} is against the 15-min trend (${ctx.trend15}) or VWAP side (${ctx.vwapSide})` };
  }
  const dirs = new Set(ok.map((p) => p.direction));
  if (dirs.size > 1) return { enter: false, reason: `patterns disagree: ${ok.map((p) => `${p.name} (${p.direction})`).join(', ')}` };
  return { enter: true, direction: ok[0].direction, patterns: ok };
}

// NSE sizing: risk = capital x risk %, and a full stop loses stop % of the
// position, so position value = risk / stop %. Capped by free cash, rounded
// down to whole lots. Returns null when even one lot does not fit.
function sizeNse({ capital, riskPct, stopPct, freeCash, premium, lot }) {
  if (!(premium > 0) || !(lot > 0)) return null;
  const riskInr = capital * riskPct / 100;
  const value = Math.min(riskInr / (stopPct / 100), freeCash);
  const lots = Math.floor(value / (premium * lot));
  if (lots < 1) return null;
  return { lots, qty: lots * lot, value: P.round(lots * lot * premium, 2), riskInr: P.round(lots * lot * premium * stopPct / 100, 2) };
}

// Crypto sizing: same risk formula, capped by an equal share of the capital
// per coin and by free balance. No leverage.
function sizeCrypto({ capital, riskPct, stopPct, freeCash, price, coins }) {
  if (!(price > 0)) return null;
  const notional = Math.min(capital * riskPct / 100 / (stopPct / 100), capital / coins, freeCash);
  if (!(notional > 0)) return null;
  return { qty: notional / price, value: P.round(notional, 2) };
}

// Simulated option price (only when no real option price exists): the option
// moves `delta` rupees per rupee the stock moves in the trade's direction.
function simOptionPrice({ entryPremium, entrySpot, spot, direction, delta }) {
  const sign = direction === 'up' ? 1 : -1;
  return Math.max(0.05, P.round(entryPremium + delta * (spot - entrySpot) * sign, 2));
}

// % change of the trade in its own favour. `short` flips the sign (crypto short).
function changePct(entry, current, short = false) {
  const raw = (current - entry) / entry * 100;
  return short ? -raw : raw;
}

// EXIT rule: target, stop, or the forced time exit. Checked at the observed
// price, so the exit price is whatever the market showed at the check.
function evaluateExit({ entry, current, targetPct, stopPct, short = false, forceReason = null }) {
  const pct = changePct(entry, current, short);
  if (pct >= targetPct) return { exit: true, reason: 'target', pct };
  if (pct <= -stopPct) return { exit: true, reason: 'stop', pct };
  if (forceReason) return { exit: true, reason: forceReason, pct };
  return { exit: false, reason: null, pct };
}

const candleText = (k) => `O ${k.o} H ${k.h} L ${k.l} C ${k.c}`;

// One plain-English sentence saying why the trade was taken.
function basisSentence({ market, symbol, score, direction, patterns, ctx, news, simulated }) {
  const what = market === 'nse' ? (direction === 'up' ? 'Bought a CALL' : 'Bought a PUT') : (direction === 'up' ? 'Went LONG' : 'Went SHORT');
  const scoreText = market === 'nse' ? `it was in the top R-factor list (R ${score})` : `its momentum score was ${score}`;
  const p = patterns.map((x) => `${x.name.replace(/_/g, ' ')} (${x.note})`).join('; ');
  const against = patterns.some((x) => x.kind === 'reversal') && ctx.trend15 !== direction ? ' This is a reversal trade against the trend, by design.' : '';
  const sim = simulated ? ' Option price is SIMULATED from the stock move (delta 0.5), not a real quote.' : '';
  return `${what} on ${symbol} because ${scoreText} and the 5-min chart showed ${p}. 15-min trend ${ctx.trend15}, price ${ctx.price} vs VWAP ${ctx.vwap} (${ctx.vwapSide === 'up' ? 'above' : ctx.vwapSide === 'down' ? 'below' : ctx.vwapSide}). News check: ${news}.${against}${sim}`;
}

module.exports = {
  median, rankRFactor, momentumScore, closedOnly, aggregate, buildContext, decideEntry,
  sizeNse, sizeCrypto, simOptionPrice, changePct, evaluateExit, basisSentence, candleText,
};
