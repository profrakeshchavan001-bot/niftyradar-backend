'use strict';
// Crypto exits from price levels instead of a fixed +2% / -1%. Pure functions, no I/O.
//   target = the nearest support (short) / resistance (long) on the other side
//            of the entry, exit 0.1% before it
//   stop   = beyond the high / low of the candles that fired the pattern (or
//            the nearest 15-min swing when the pattern gives none), plus 1 x ATR14 (15-min)
//   trade only when reward / risk >= 1.5
// Levels looked at: swing highs / lows (15-min and 1-hour), order blocks,
// fair value gap edges, previous day and previous week high / low (UTC).
const P = require('./patterns');
const { swingLevels } = require('./rfactor');

const DAY = 86400000;
const WEEK = 7 * DAY;
const MONDAY_OFFSET = 4 * DAY; // 1 Jan 1970 was a Thursday, so the first Monday 00:00 UTC is 4 days later

// High / low of the previous UTC day and the previous UTC week (Mon-Sun),
// from candles that cover them. A period with no candle gives no level.
function previousPeriods(candles, nowMs) {
  const out = [];
  const add = (from, to, name) => {
    const rows = candles.filter((k) => k.t >= from && k.t < to);
    if (!rows.length) return;
    out.push({ price: Math.max(...rows.map((k) => k.h)), type: `previous ${name} high` }, { price: Math.min(...rows.map((k) => k.l)), type: `previous ${name} low` });
  };
  const dayStart = Math.floor(nowMs / DAY) * DAY;
  add(dayStart - DAY, dayStart, 'day');
  const weekStart = Math.floor((nowMs - MONDAY_OFFSET) / WEEK) * WEEK + MONDAY_OFFSET;
  add(weekStart - WEEK, weekStart, 'week');
  return out;
}

// Order blocks in the last `look` candles: the last opposite candle before an
// impulsive candle (body >= `impulse` x the average body of the 5 before it).
// A red candle before an up impulse is support; a green one before a down
// impulse is resistance. The level is the edge the price meets first.
function orderBlockLevels(c, { look = 60, impulse = 2 } = {}) {
  const out = [];
  for (let i = Math.max(6, c.length - look); i < c.length; i++) {
    const base = P.avg(c.slice(i - 5, i).map(P.body));
    if (!(base > 0) || P.body(c[i]) < impulse * base) continue;
    const ob = c[i - 1];
    if (P.isGreen(c[i]) && P.isRed(ob)) out.push({ price: ob.h, type: 'order block', side: 'support' });
    if (P.isRed(c[i]) && P.isGreen(ob)) out.push({ price: ob.l, type: 'order block', side: 'resistance' });
  }
  return out;
}

// Fair value gaps in the last `look` candles that no later candle has filled.
// A gap left by an up move is support (edge = its top); a gap left by a down
// move is resistance (edge = its bottom).
function fvgLevels(c, { look = 60 } = {}) {
  const out = [];
  for (let i = Math.max(1, c.length - look); i < c.length - 1; i++) {
    const a = c[i - 1];
    const d = c[i + 1];
    const later = c.slice(i + 2);
    if (a.h < d.l && !later.some((x) => x.l <= a.h)) out.push({ price: d.l, type: 'FVG edge', side: 'support' });
    if (a.l > d.h && !later.some((x) => x.h >= a.l)) out.push({ price: d.h, type: 'FVG edge', side: 'resistance' });
  }
  return out;
}

// Every level the bot knows, as { price, type }. `c5`, `c15`, `c1h` are closed candles, oldest first.
function collectLevels({ c5, c15, c1h, nowMs, opt = {} }) {
  const s15 = swingLevels(c15, opt.swingK || 2, opt.swingLookback15 || 40);
  const s1h = swingLevels(c1h, opt.swingK || 2, opt.swingLookback1h || 48);
  return [
    ...s15.highs.map((price) => ({ price, type: 'swing high 15m' })), ...s15.lows.map((price) => ({ price, type: 'swing low 15m' })),
    ...s1h.highs.map((price) => ({ price, type: 'swing high 1h' })), ...s1h.lows.map((price) => ({ price, type: 'swing low 1h' })),
    ...orderBlockLevels(c5, opt).map(({ price, type }) => ({ price, type })),
    ...fvgLevels(c5, opt).map(({ price, type }) => ({ price, type })),
    ...previousPeriods(c1h, nowMs),
  ].filter((l) => l.price > 0);
}

// The plan for one trade, or { ok: false, reason } when it must be skipped.
// `direction` is 'up' (long) or 'down' (short). `patterns` are the pattern hits
// that fired (each with its candles). Any level at or beyond the entry on the
// target side counts, whatever it was called; the nearest one is the target.
function planTrade({ entry, direction, patterns, c5, c15, c1h, nowMs, opt = {} }) {
  const o = { minRr: 1.5, targetBufferPct: 0.1, atrStopMult: 1, minLevelDistAtr: 1, ...opt };
  const long = direction === 'up';
  const atr = P.atr(c15, 14);
  if (!(entry > 0) || c15.length < 15 || !(atr > 0)) return { ok: false, reason: 'not enough 15-min candles for ATR14, no stop can be set' };
  const buf = o.targetBufferPct / 100;

  // target: nearest level on the far side whose "0.1% before" price is still beyond the entry,
  // skipping any level closer than minLevelDistAtr x ATR14(15m) to the entry (CC2 item 4) - too
  // close to leave room for the trade, so the next one out is used instead.
  const far = collectLevels({ c5, c15, c1h, nowMs, opt: o })
    .map((l) => ({ ...l, exit: long ? l.price * (1 - buf) : l.price * (1 + buf) }))
    .filter((l) => (long ? l.exit > entry : l.exit < entry))
    .sort((a, b) => (long ? a.price - b.price : b.price - a.price));
  const cands = far.filter((l) => Math.abs(l.price - entry) >= o.minLevelDistAtr * atr);
  if (!far.length) return { ok: false, reason: `no ${long ? 'resistance' : 'support'} level found ${long ? 'above' : 'below'} the entry, so no target` };
  if (!cands.length) return { ok: false, reason: `every ${long ? 'resistance' : 'support'} level found is within ${o.minLevelDistAtr} x ATR14 (${P.round(atr, 6)}) of the entry, no room for a target` };
  const lvl = cands[0];

  // stop: beyond the pattern's own low (long) / high (short); if the pattern gives none on that side, the nearest 15-min swing
  const candles = patterns.flatMap((p) => p.candles || []);
  let base = candles.length ? (long ? Math.min(...candles.map((k) => k.l)) : Math.max(...candles.map((k) => k.h))) : null;
  let stopType = long ? 'pattern low' : 'pattern high';
  if (base == null || (long ? base >= entry : base <= entry)) {
    const s = swingLevels(c15, o.swingK || 2, o.swingLookback15 || 40);
    const side = (long ? s.lows.filter((x) => x < entry) : s.highs.filter((x) => x > entry));
    if (!side.length) return { ok: false, reason: 'no pattern low / high and no 15-min swing beyond the entry, so no stop' };
    base = long ? Math.max(...side) : Math.min(...side);
    stopType = long ? 'swing low 15m' : 'swing high 15m';
  }
  const stop = long ? base - o.atrStopMult * atr : base + o.atrStopMult * atr;
  const reward = Math.abs(lvl.exit - entry);
  const risk = Math.abs(entry - stop);
  const rr = P.round(reward / risk, 2);
  const plan = {
    target: P.round(lvl.exit, 6), targetLevel: lvl.price, targetType: lvl.type,
    stop: P.round(stop, 6), stopBase: base, stopType: `${stopType} + ${o.atrStopMult} x ATR`, atr15: P.round(atr, 6), rr,
    riskPct: P.round(risk / entry * 100, 4), rewardPct: P.round(reward / entry * 100, 4),
  };
  if (rr < o.minRr) return { ok: false, plan, reason: `reward/risk ${rr} is below ${o.minRr} (target ${plan.target} before ${lvl.type} ${lvl.price}, stop ${plan.stop})` };
  return { ok: true, plan };
}

// What to do with an open trade at `price`: exit at the target or the stop,
// move the stop to the entry once half the way to the target is covered, or hold.
function manageTrade({ entry, target, stop, short, price, breakevenDone, breakevenAt = 0.5 }) {
  const dir = short ? -1 : 1;
  if ((price - target) * dir >= 0) return { action: 'exit', reason: 'target' };
  if ((price - stop) * dir <= 0) return { action: 'exit', reason: breakevenDone ? 'breakeven_stop' : 'stop' };
  if (!breakevenDone && (price - entry) * dir >= breakevenAt * Math.abs(target - entry)) return { action: 'breakeven', stop: entry };
  return { action: 'hold' };
}

// The old fixed rule (+target% / -stop% from the entry), kept only for comparison.
function legacyLevels({ entry, short, targetPct, stopPct }) {
  const dir = short ? -1 : 1;
  return { target: P.round(entry * (1 + dir * targetPct / 100), 6), stop: P.round(entry * (1 - dir * stopPct / 100), 6) };
}
// 'target', 'stop' or null (not decided yet) for the old fixed rule at `price`.
function legacyOutcome({ target, stop, short, price }) {
  const dir = short ? -1 : 1;
  if ((price - target) * dir >= 0) return 'target';
  if ((price - stop) * dir <= 0) return 'stop';
  return null;
}

module.exports = { previousPeriods, orderBlockLevels, fvgLevels, collectLevels, planTrade, manageTrade, legacyLevels, legacyOutcome };
