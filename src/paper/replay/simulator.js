'use strict';
// Replay simulator: runs the REAL scalp decision code (src/paper/scalp/engine.js: analyse/evaluateExit/settle,
// imported, never copied) over stored history, one candle at a time. PAPER ONLY, no order code.
//
// Rules followed, from docs/SCALP.md / the overnight brief:
//  - a decision may use only candles that have closed by the time it is made (enforced by windowing below,
//    not by the engine, which is why scanSignals() is tested directly for look-ahead in test/paperReplaySimulator.test.js)
//  - one open trade at a time per symbol (matches the live cron: scan only runs when nothing is open for that coin)
//  - entry price, stop and target are fixed at the decision candle, exactly as analyse() returns them
//  - exits (target / stop / breakeven / time) and settlement (fees + slippage) reuse evaluateExit()/settle() unchanged
const { analyse, evaluateExit, settle } = require('../scalp/engine');
const { sizeCrypto } = require('../../../paperbot/engine');
const { istDayStart } = require('../../../paperbot/time');

const MIN = 60000;
const WINDOW_1M = 120; // same rolling window the live source fetches (src/paper/scalp/source.js candles1m(symbol, 120))
const WINDOW_5M = 330; // same as paperbot/sources.js crypto.candles() default limit

function round(x, n = 6) { const m = 10 ** n; return Math.round(x * m) / m; }

function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Builds, for every closed 1-minute candle, the exact rolling windows the live bot would have seen at that
// moment, and asks the REAL analyse() for a decision. This is the only place that decides what is "closed by
// now" -- analyse() itself trusts whatever candles it is given, so look-ahead safety lives here and is tested
// directly (test/paperReplaySimulator.test.js "look-ahead").
function scanSignals({ candles1m, candles5m, cfg }) {
  const signals = [];
  let c5Cursor = 0;
  for (let i = cfg.min_candles_1m - 1; i < candles1m.length; i++) {
    const now = candles1m[i].t + MIN;
    while (c5Cursor < candles5m.length && candles5m[c5Cursor].t + 5 * MIN <= now) c5Cursor++;
    const c1raw = candles1m.slice(Math.max(0, i - WINDOW_1M + 1), i + 1);
    const c5raw = candles5m.slice(Math.max(0, c5Cursor - WINDOW_5M), c5Cursor);
    const a = analyse({ c1raw, c5raw, now, cfg, dayStartMs: istDayStart(now) });
    if (a.ok) signals.push({ i, now, plan: a.plan });
  }
  return signals;
}

// Resolves one entry into a closed (or still-open-at-end-of-data) trade using the real evaluateExit()/settle().
function resolveTrade({ symbol, candles1m, triggerIndex, trade, cfg, fxRate, extra }) {
  const future = candles1m.slice(triggerIndex + 1);
  const endOfData = candles1m[candles1m.length - 1].t + MIN;
  const ev = evaluateExit({ trade, candles: future, nowMs: endOfData, cfg });
  if (!ev.exit) return { resolved: false };
  const s = settle({ trade, exitPrice: ev.price, cfg, fxRate });
  const exitIdx = candles1m.findIndex((k) => k.t + MIN === ev.timeMs);
  return {
    resolved: true,
    nextIndex: exitIdx > triggerIndex ? exitIdx : null, // null = could not place the exit candle: caller stops rather than risk an overlap
    row: {
      symbol, direction: trade.direction, entry_t: trade.trigger_t, entry_price: trade.entry_price, qty: trade.qty,
      exit_t: ev.timeMs, exit_price: ev.price, exit_reason: ev.reason, stop_pct: extra.stopPct, target_pct: extra.targetPct,
      rr: extra.rr ?? null, patterns: extra.patterns || [], max_fav_pct: ev.favPct, max_adv_pct: ev.advPct, be_moved: ev.beMoved,
      ...s,
    },
  };
}

// Sizing (brief item 2: "2% risk from the stop distance"), via the real sizeCrypto(). A symbol is replayed
// in isolation (not interleaved minute-by-minute with the other coins), so there is no real shared "free
// cash" across coins to track here; each coin is simply given its fixed, always-available share of the
// virtual capital (capital_usdt / number of symbols), the same equal-share cap the live sizing already
// applies. Documented in docs/REPLAY.md.
function sizeFor(cfg, stopPct, price) {
  const coins = cfg.symbols.length;
  return sizeCrypto({ capital: cfg.capital_usdt, riskPct: cfg.risk_pct, stopPct, freeCash: cfg.capital_usdt / coins, price, coins });
}

// Replays the live scalp strategy for one symbol. `cfg` may already have doubled costs (the doubled-cost
// check) -- analyse()/evaluateExit()/settle() are unmodified either way.
function replayScalp({ symbol, candles1m, candles5m, cfg, fxRate = 88 }) {
  const signals = scanSignals({ candles1m, candles5m, cfg });
  const trades = [];
  let nextFreeIndex = cfg.min_candles_1m - 1;
  for (const sig of signals) {
    if (sig.i < nextFreeIndex) continue; // a trade was open through this bar (matches the live "one open trade per coin" rule)
    const plan = sig.plan;
    const size = sizeFor(cfg, plan.stopPct, plan.entry);
    if (!size) continue; // no free virtual balance for this stop distance: skip, same as the live bot
    const trade = {
      direction: plan.long ? 'LONG' : 'SHORT', entry_price: plan.entry, trigger_t: plan.last.t,
      sl_price: plan.stopPrice, target_price: plan.targetPrice, qty: size.qty,
    };
    const r = resolveTrade({
      symbol, candles1m, triggerIndex: sig.i, trade, cfg, fxRate,
      extra: { stopPct: plan.stopPct, targetPct: plan.targetPct, rr: plan.rr, patterns: plan.hits.map((h) => h.name) },
    });
    if (!r.resolved) break; // ran out of history before this trade closed: drop it, never invent an exit
    trades.push({ ...r.row, hour_utc: new Date(r.row.entry_t).getUTCHours() });
    if (r.nextIndex == null) break; // could not locate the exit candle: stop rather than risk an overlapping trade
    nextFreeIndex = r.nextIndex + 1;
  }
  return trades;
}

// Random-entry baseline (brief item 5): same stop%/target% distribution as the real strategy's own closed
// trades (resampled with replacement), random direction, entries at uniformly random minutes with the same
// expected trade COUNT as the real run over the same period, walked forward with the SAME evaluateExit()/
// settle() (same costs, breakeven, time-stop) -- only the entry signal is fake.
function replayRandomBaseline({ symbol, candles1m, realTrades, cfg, fxRate = 88, seed = 1 }) {
  if (!realTrades.length || candles1m.length <= cfg.min_candles_1m) return [];
  const rng = mulberry32(seed);
  const trades = [];
  const start = cfg.min_candles_1m - 1;
  const pEntry = Math.min(1, realTrades.length / Math.max(1, candles1m.length - start));
  let i = start; let guard = 0;
  while (i < candles1m.length && guard < candles1m.length * 2) {
    guard += 1;
    if (rng() >= pEntry) { i += 1; continue; }
    const sample = realTrades[Math.floor(rng() * realTrades.length)];
    const long = rng() < 0.5;
    const sgn = long ? 1 : -1;
    const entry = candles1m[i].c;
    const size = sizeFor(cfg, sample.stop_pct, entry);
    if (!size) { i += 1; continue; }
    const trade = {
      direction: long ? 'LONG' : 'SHORT', entry_price: entry, trigger_t: candles1m[i].t, qty: size.qty,
      sl_price: round(entry * (1 - sgn * sample.stop_pct / 100)), target_price: round(entry * (1 + sgn * sample.target_pct / 100)),
    };
    const r = resolveTrade({ symbol, candles1m, triggerIndex: i, trade, cfg, fxRate, extra: { stopPct: sample.stop_pct, targetPct: sample.target_pct, rr: null, patterns: ['random_baseline'] } });
    if (!r.resolved) break;
    trades.push({ ...r.row, hour_utc: new Date(r.row.entry_t).getUTCHours() });
    i = r.nextIndex != null ? r.nextIndex + 1 : i + 1;
  }
  return trades;
}

module.exports = { scanSignals, resolveTrade, replayScalp, replayRandomBaseline, mulberry32, WINDOW_1M, WINDOW_5M };
