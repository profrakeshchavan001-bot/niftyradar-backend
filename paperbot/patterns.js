'use strict';
// Paper bot: indicators and candle-pattern detection. Pure functions, no I/O.
// A candle is { t, o, h, l, c, v } (t = open time in ms). Arrays are oldest
// first and must contain CLOSED candles only.

const isGreen = (k) => k.c > k.o;
const isRed = (k) => k.c < k.o;
const body = (k) => Math.abs(k.c - k.o);
const range = (k) => k.h - k.l;
const upperWick = (k) => k.h - Math.max(k.o, k.c);
const lowerWick = (k) => Math.min(k.o, k.c) - k.l;
const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);
const round = (x, d = 2) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);

// Exponential moving average of the closes; seeded with the simple average of
// the first n values. Returns null when there are fewer than n values.
function ema(values, n) {
  if (!Array.isArray(values) || values.length < n || n < 1) return null;
  const k = 2 / (n + 1);
  let e = avg(values.slice(0, n));
  for (let i = n; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

// Volume-weighted average price over the given candles (typical price).
// With no volume at all it falls back to the plain average typical price.
function vwap(candles) {
  let pv = 0;
  let vol = 0;
  let tp = 0;
  for (const k of candles) {
    const typical = (k.h + k.l + k.c) / 3;
    pv += typical * (k.v || 0);
    vol += k.v || 0;
    tp += typical;
  }
  if (!candles.length) return null;
  return vol > 0 ? pv / vol : tp / candles.length;
}

// Average true range (simple average of the last n true ranges).
function atr(candles, n = 14) {
  if (candles.length < 2) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const k = candles[i];
    const pc = candles[i - 1].c;
    trs.push(Math.max(k.h - k.l, Math.abs(k.h - pc), Math.abs(k.l - pc)));
  }
  return avg(trs.slice(-n));
}

// Trend of a candle series: 'up' when the last close is above EMA(n) and the
// EMA is rising, 'down' for the mirror, otherwise 'flat'. 'unknown' when there
// are not enough candles (never guessed).
function trendOf(candles, n = 20) {
  if (!candles || candles.length < n + 1) return 'unknown';
  const closes = candles.map((k) => k.c);
  const now = ema(closes, n);
  const before = ema(closes.slice(0, -1), n);
  const last = closes[closes.length - 1];
  if (last > now && now > before) return 'up';
  if (last < now && now < before) return 'down';
  return 'flat';
}

const pick = (k) => ({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v });

function hit(name, direction, kind, used, note) {
  return { name, direction, kind, candles: used.map(pick), note };
}

// --- The owner's favourite: exhaustion reversal -----------------------------
// Downtrend (at least `minTrend` of the `lookback` candles before the small
// candle are red, and the small candle closes below VWAP), then a small-body
// red candle, then a green candle closing above the small candle's high: up.
// Mirror in an uptrend: down.
function exhaustionReversal(c, ctx = {}, opt = {}) {
  const lookback = opt.lookback || 6;
  const minTrend = opt.minTrend || 4;
  const smallRatio = opt.smallBodyRatio || 0.5;
  if (c.length < lookback + 2 || ctx.vwap == null) return null;
  const last = c[c.length - 1];
  const small = c[c.length - 2];
  const prior = c.slice(-(lookback + 2), -2);
  const avgBody = avg(prior.map(body));
  if (!(avgBody > 0) || body(small) > smallRatio * avgBody) return null;
  const reds = prior.filter(isRed).length;
  const greens = prior.filter(isGreen).length;
  if (reds >= minTrend && isRed(small) && small.c < ctx.vwap && isGreen(last) && last.c > small.h) {
    return hit('exhaustion_reversal', 'up', 'reversal', [small, last],
      `${reds} of last ${lookback} candles red, small red body ${round(body(small))} (avg ${round(avgBody)}), green close ${last.c} above its high ${small.h}`);
  }
  if (greens >= minTrend && isGreen(small) && small.c > ctx.vwap && isRed(last) && last.c < small.l) {
    return hit('exhaustion_reversal', 'down', 'reversal', [small, last],
      `${greens} of last ${lookback} candles green, small green body ${round(body(small))} (avg ${round(avgBody)}), red close ${last.c} below its low ${small.l}`);
  }
  return null;
}

// --- Classic patterns --------------------------------------------------------
function engulfing(c) {
  if (c.length < 2) return null;
  const a = c[c.length - 2];
  const b = c[c.length - 1];
  if (isRed(a) && isGreen(b) && b.o <= a.c && b.c >= a.o && body(b) > body(a)) {
    return hit('bullish_engulfing', 'up', 'classic', [a, b], `green body ${b.o}-${b.c} covers red body ${a.o}-${a.c}`);
  }
  if (isGreen(a) && isRed(b) && b.o >= a.c && b.c <= a.o && body(b) > body(a)) {
    return hit('bearish_engulfing', 'down', 'classic', [a, b], `red body ${b.o}-${b.c} covers green body ${a.o}-${a.c}`);
  }
  return null;
}

// Hammer: long lower wick (>= 2x body), tiny upper wick, after a fall
// (close below the close 3 candles earlier).
function hammer(c) {
  if (c.length < 4) return null;
  const k = c[c.length - 1];
  const r = range(k);
  if (!(r > 0) || !(body(k) > 0)) return null;
  if (lowerWick(k) >= 2 * body(k) && upperWick(k) <= 0.25 * r && k.c < c[c.length - 4].c) {
    return hit('hammer', 'up', 'classic', [k], `lower wick ${round(lowerWick(k))} is ${round(lowerWick(k) / body(k), 1)}x the body after a fall`);
  }
  return null;
}

// Shooting star: long upper wick (>= 2x body), tiny lower wick, after a rise.
function shootingStar(c) {
  if (c.length < 4) return null;
  const k = c[c.length - 1];
  const r = range(k);
  if (!(r > 0) || !(body(k) > 0)) return null;
  if (upperWick(k) >= 2 * body(k) && lowerWick(k) <= 0.25 * r && k.c > c[c.length - 4].c) {
    return hit('shooting_star', 'down', 'classic', [k], `upper wick ${round(upperWick(k))} is ${round(upperWick(k) / body(k), 1)}x the body after a rise`);
  }
  return null;
}

// Morning star: big red, small middle candle, green closing above the middle
// of the red body. Evening star is the mirror.
function star(c) {
  if (c.length < 3) return null;
  const [a, b, d] = c.slice(-3);
  if (!(body(a) > 0) || body(b) > 0.5 * body(a)) return null;
  const mid = (a.o + a.c) / 2;
  if (isRed(a) && isGreen(d) && d.c > mid && Math.max(b.o, b.c) < mid) {
    return hit('morning_star', 'up', 'classic', [a, b, d], `red ${a.o}-${a.c}, small candle, green close ${d.c} above red midpoint ${round(mid)}`);
  }
  if (isGreen(a) && isRed(d) && d.c < mid && Math.min(b.o, b.c) > mid) {
    return hit('evening_star', 'down', 'classic', [a, b, d], `green ${a.o}-${a.c}, small candle, red close ${d.c} below green midpoint ${round(mid)}`);
  }
  return null;
}

// Inside-bar breakout: the middle candle sits inside the mother candle's
// high-low, and the last candle closes beyond the mother's high or low.
function insideBarBreakout(c) {
  if (c.length < 3) return null;
  const [m, i, b] = c.slice(-3);
  if (!(i.h <= m.h && i.l >= m.l && range(i) < range(m))) return null;
  if (b.c > m.h) return hit('inside_bar_breakout', 'up', 'classic', [m, i, b], `inside bar ${i.l}-${i.h} within ${m.l}-${m.h}, close ${b.c} above ${m.h}`);
  if (b.c < m.l) return hit('inside_bar_breakout', 'down', 'classic', [m, i, b], `inside bar ${i.l}-${i.h} within ${m.l}-${m.h}, close ${b.c} below ${m.l}`);
  return null;
}

// --- SMC / ICT ---------------------------------------------------------------
// Liquidity sweep: the last candle's wick takes the prior swing low (lowest low
// of the `swing` candles before it) and the candle closes back above it: up.
function liquiditySweep(c, opt = {}) {
  const swing = opt.swing || 10;
  if (c.length < swing + 1) return null;
  const k = c[c.length - 1];
  const prior = c.slice(-(swing + 1), -1);
  const lo = Math.min(...prior.map((x) => x.l));
  const hi = Math.max(...prior.map((x) => x.h));
  if (k.l < lo && k.c > lo && k.c < hi) return hit('liquidity_sweep', 'up', 'smc', [k], `wick low ${k.l} took swing low ${lo}, closed back at ${k.c}`);
  if (k.h > hi && k.c < hi && k.c > lo) return hit('liquidity_sweep', 'down', 'smc', [k], `wick high ${k.h} took swing high ${hi}, closed back at ${k.c}`);
  return null;
}

// Simple order block: the last opposite candle before an impulsive candle
// (body >= `impulse` x the average body of the 5 candles before it). Fires
// when the last candle dips into that candle's high-low zone and closes back
// out of it in the impulse direction.
function orderBlock(c, opt = {}) {
  const look = opt.look || 12;
  const impulse = opt.impulse || 2;
  if (c.length < 8) return null;
  const last = c[c.length - 1];
  const start = Math.max(6, c.length - look);
  for (let i = c.length - 3; i >= start; i--) {
    const imp = c[i];
    const base = avg(c.slice(i - 5, i).map(body));
    if (!(base > 0) || body(imp) < impulse * base) continue;
    const ob = c[i - 1];
    const between = c.slice(i + 1, -1);
    if (isGreen(imp) && isRed(ob)) {
      if (between.some((x) => x.l <= ob.h)) continue; // zone already tested
      if (last.l <= ob.h && last.l >= ob.l && last.c > ob.h && isGreen(last)) {
        return hit('order_block', 'up', 'smc', [ob, imp, last], `retest of red candle zone ${ob.l}-${ob.h} before the up move, close ${last.c}`);
      }
    }
    if (isRed(imp) && isGreen(ob)) {
      if (between.some((x) => x.h >= ob.l)) continue;
      if (last.h >= ob.l && last.h <= ob.h && last.c < ob.l && isRed(last)) {
        return hit('order_block', 'down', 'smc', [ob, imp, last], `retest of green candle zone ${ob.l}-${ob.h} before the down move, close ${last.c}`);
      }
    }
  }
  return null;
}

// Fair value gap retest: three candles where the first one's high is below the
// third one's low leave a gap (up). Fires when the last candle dips into an
// untouched gap, does not close below it, and closes above the gap top.
function fvgRetest(c, opt = {}) {
  const look = opt.look || 12;
  if (c.length < 5) return null;
  const last = c[c.length - 1];
  const start = Math.max(1, c.length - look);
  for (let i = c.length - 3; i >= start; i--) {
    const a = c[i - 1];
    const d = c[i + 1];
    const between = c.slice(i + 2, -1);
    if (a.h < d.l) {
      const bottom = a.h;
      const top = d.l;
      if (between.some((x) => x.l <= top)) continue;
      if (last.l <= top && last.l >= bottom && last.c > top) {
        return hit('fvg_retest', 'up', 'smc', [a, c[i], d, last], `gap ${bottom}-${top} retested, low ${last.l}, close ${last.c}`);
      }
    }
    if (a.l > d.h) {
      const top = a.l;
      const bottom = d.h;
      if (between.some((x) => x.h >= bottom)) continue;
      if (last.h >= bottom && last.h <= top && last.c < bottom) {
        return hit('fvg_retest', 'down', 'smc', [a, c[i], d, last], `gap ${bottom}-${top} retested, high ${last.h}, close ${last.c}`);
      }
    }
  }
  return null;
}

// --- NSE-only variant: the owner's rule, with a second-candle confirmation ---
// Same downtrend + small-body red candle as exhaustionReversal() above, but the entry/signal
// does NOT fire on the first green candle closing above the small candle's high. It waits one
// more candle: that first green candle is only the (unsignalled) start of the reversal, and the
// ACTUAL entry is confirmed only when a SECOND green candle follows, closing above the first
// green candle's high. Mirror for a rising move (two reds confirm a short). This is additive -
// exhaustionReversal() itself is unchanged and still used as-is by every crypto bot (scalp,
// scalp_wide, exhaustion_only, the shared DETECTORS list below) - this stricter, two-candle
// variant is used only for the NSE path (paperbot/bot.js's analyse(), `variant: 'nse'`).
function exhaustionReversalConfirmed(c, ctx = {}, opt = {}) {
  const lookback = opt.lookback || 6;
  const minTrend = opt.minTrend || 4;
  const smallRatio = opt.smallBodyRatio || 0.5;
  if (c.length < lookback + 3 || ctx.vwap == null) return null;
  const last = c[c.length - 1]; // the SECOND green/red candle - this is where entry is signalled
  const confirm1 = c[c.length - 2]; // the FIRST green/red candle - closed beyond the small candle, but not itself a signal
  const small = c[c.length - 3]; // the small reversal candle
  const prior = c.slice(-(lookback + 3), -3);
  const avgBody = avg(prior.map(body));
  if (!(avgBody > 0) || body(small) > smallRatio * avgBody) return null;
  const reds = prior.filter(isRed).length;
  const greens = prior.filter(isGreen).length;
  if (reds >= minTrend && isRed(small) && small.c < ctx.vwap && isGreen(confirm1) && confirm1.c > small.h && isGreen(last) && last.c > confirm1.h) {
    return hit('exhaustion_reversal', 'up', 'reversal', [small, confirm1, last],
      `${reds} of last ${lookback} candles red, small red body ${round(body(small))} (avg ${round(avgBody)}), first green close ${confirm1.c} above its high ${small.h}, confirmed by a second green close ${last.c} above ${confirm1.h}`);
  }
  if (greens >= minTrend && isGreen(small) && small.c > ctx.vwap && isRed(confirm1) && confirm1.c < small.l && isRed(last) && last.c < confirm1.l) {
    return hit('exhaustion_reversal', 'down', 'reversal', [small, confirm1, last],
      `${greens} of last ${lookback} candles green, small green body ${round(body(small))} (avg ${round(avgBody)}), first red close ${confirm1.c} below its low ${small.l}, confirmed by a second red close ${last.c} below ${confirm1.l}`);
  }
  return null;
}

const DETECTORS = [exhaustionReversal, engulfing, hammer, shootingStar, star, insideBarBreakout, liquiditySweep, orderBlock, fvgRetest];
// NSE variant: exactly the same list, with the two-candle-confirmed exhaustion reversal instead of the single-candle one.
const DETECTORS_NSE = [exhaustionReversalConfirmed, engulfing, hammer, shootingStar, star, insideBarBreakout, liquiditySweep, orderBlock, fvgRetest];

// Runs every detector on the closed candles. `ctx.vwap` is needed for the
// exhaustion reversal. Returns a list (possibly empty) of pattern hits.
// `variant`: 'default' (every existing caller, unchanged) or 'nse' (paperbot/bot.js's NSE
// analyse() only) - picks which exhaustion-reversal rule runs, see exhaustionReversalConfirmed().
function detectPatterns(candles, ctx = {}, opt = {}, variant = 'default') {
  const out = [];
  for (const fn of (variant === 'nse' ? DETECTORS_NSE : DETECTORS)) {
    const r = fn(candles, ctx, opt);
    if (r) out.push(r);
  }
  return out;
}

module.exports = {
  ema, vwap, atr, trendOf, detectPatterns,
  exhaustionReversal, exhaustionReversalConfirmed, engulfing, hammer, shootingStar, star, insideBarBreakout,
  liquiditySweep, orderBlock, fvgRetest,
  isGreen, isRed, body, range, avg, round,
};
