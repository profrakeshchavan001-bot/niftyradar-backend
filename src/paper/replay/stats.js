'use strict';
// Honest reporting of replayed trades (brief item 4). Never invents a number: a group under
// MIN_TRADES trades reports only { trades, tooFew: true, note: 'too few trades, no conclusion' }.
const MIN_TRADES = 20;

const round2 = (x) => Math.round(x * 100) / 100;
const avg = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;

function drawdownAndStreak(tradesInOrder) {
  let equity = 0; let peak = 0; let maxDd = 0; let streak = 0; let longest = 0;
  for (const t of tradesInOrder) {
    equity += t.pnl_inr;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    if (t.pnl_inr <= 0) { streak += 1; longest = Math.max(longest, streak); } else streak = 0;
  }
  return { maxDrawdownInr: round2(maxDd), longestLosingStreak: longest };
}

// `trades` must already be sorted by entry_t ascending (callers pass sorted slices).
function basicMetrics(trades) {
  const n = trades.length;
  if (n < MIN_TRADES) return { trades: n, tooFew: true, note: 'too few trades, no conclusion' };
  const wins = trades.filter((t) => t.pnl_inr > 0);
  const losses = trades.filter((t) => t.pnl_inr <= 0);
  const { maxDrawdownInr, longestLosingStreak } = drawdownAndStreak(trades);
  return {
    trades: n, tooFew: false,
    winRatePct: round2(100 * wins.length / n),
    netInr: round2(trades.reduce((s, t) => s + t.pnl_inr, 0)),
    avgWinInr: wins.length ? round2(avg(wins.map((t) => t.pnl_inr))) : null,
    avgLossInr: losses.length ? round2(avg(losses.map((t) => t.pnl_inr))) : null,
    maxDrawdownInr,
    longestLosingStreak,
  };
}

function byGroup(sortedTrades, keyFn) {
  const groups = new Map();
  for (const t of sortedTrades) {
    const k = keyFn(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const out = {};
  for (const [k, rows] of groups) out[k] = basicMetrics(rows);
  return out;
}

// Approximate, non-overlapping UTC-hour buckets. Crypto trades 24/7, so these are not real market
// sessions (there is no close) -- just a plain way to see if results cluster by time of day.
function sessionOf(hourUtc) {
  if (hourUtc < 8) return 'asia_00-08_utc';
  if (hourUtc < 16) return 'europe_08-16_utc';
  return 'us_16-24_utc';
}

// `trades` need not be sorted; this sorts a copy once and reuses it for every breakdown.
function buildReport(trades) {
  const sorted = [...trades].sort((a, b) => a.entry_t - b.entry_t);
  return {
    overall: basicMetrics(sorted),
    byCoin: byGroup(sorted, (t) => t.symbol),
    byHourUtc: byGroup(sorted, (t) => String(t.hour_utc)),
    bySession: byGroup(sorted, (t) => sessionOf(t.hour_utc)),
  };
}

// Splits a trade list into in-sample (first `inSampleDays` of the window) and out-of-sample (the rest),
// by entry time, against a single continuous simulator run (brief item 4: "first 20 in-sample, last 10
// out-of-sample" of a 30-day window). Splitting the resulting trades, rather than re-running the simulator
// on two separate slices, avoids a fresh warm-up period (min_candles_1m) at the start of the out-of-sample
// segment that a real live bot restarting would not have.
function splitInOutSample(trades, { windowStartMs, inSampleDays }) {
  const cutoff = windowStartMs + inSampleDays * 86400000;
  return {
    inSample: trades.filter((t) => t.entry_t < cutoff),
    outSample: trades.filter((t) => t.entry_t >= cutoff),
  };
}

module.exports = { MIN_TRADES, basicMetrics, buildReport, splitInOutSample, sessionOf, drawdownAndStreak };
