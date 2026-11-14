'use strict';
// Look-ahead check (brief item 5): changing future candles must not change past decisions.
// scanSignals() (src/paper/replay/simulator.js) is the only place that decides which candles are "closed
// by now" before handing them to the real, imported analyse(); this proves that windowing never leaks.
const { scanSignals, scanSignalsWide, scanDecideSignals } = require('./simulator');

function corruptFrom(candles, fromIndex) {
  return candles.map((k, i) => (i < fromIndex ? k : { t: k.t, o: k.o * 9, h: k.h * 9, l: Math.max(k.l / 9, 0.0001), c: k.c * 9, v: k.v * 9 }));
}

// Everything at or after `cutoffBar1m` (by candle index into `candles1m`, and by matching timestamp into
// `candles5m`) is multiplied into nonsense. Signals decided strictly before the cutoff must be byte-identical.
function lookAheadCheck({ candles1m, candles5m, cfg, cutoffBar1m }) {
  const cutoffT = candles1m[cutoffBar1m].t;
  const c1Corrupt = corruptFrom(candles1m, cutoffBar1m);
  const c5CutIndex = candles5m.findIndex((k) => k.t >= cutoffT);
  const c5Corrupt = c5CutIndex === -1 ? candles5m : corruptFrom(candles5m, c5CutIndex);
  const before = scanSignals({ candles1m, candles5m, cfg }).filter((s) => s.i < cutoffBar1m);
  const after = scanSignals({ candles1m: c1Corrupt, candles5m: c5Corrupt, cfg }).filter((s) => s.i < cutoffBar1m);
  const identical = before.length === after.length && before.every((s, idx) => JSON.stringify(s.plan) === JSON.stringify(after[idx].plan));
  return { ok: identical, signalsBeforeCutoff: before.length, signalsAfterCorruption: after.length };
}

// Same check for scalp_wide (single 5-minute stream, analyseWide()).
function lookAheadCheckWide({ candles5m, cfg, cutoffBar5m }) {
  const c5Corrupt = corruptFrom(candles5m, cutoffBar5m);
  const before = scanSignalsWide({ candles5m, cfg }).filter((s) => s.i < cutoffBar5m);
  const after = scanSignalsWide({ candles5m: c5Corrupt, cfg }).filter((s) => s.i < cutoffBar5m);
  const identical = before.length === after.length && before.every((s, idx) => JSON.stringify(s.plan) === JSON.stringify(after[idx].plan));
  return { ok: identical, signalsBeforeCutoff: before.length, signalsAfterCorruption: after.length };
}

// Same check for any decide(candles,context)-shaped adapter (src/paper/replay/adapters/): exhaustion_only
// today, trend_smc when it lands, with zero new look-ahead-checking code needed per adapter.
function lookAheadCheckDecide({ candles, intervalMs, decide, buildContext, cfg, minCandles, window, cutoffBar }) {
  const corrupt = corruptFrom(candles, cutoffBar);
  const before = scanDecideSignals({ candles, intervalMs, decide, buildContext, cfg, minCandles, window }).filter((s) => s.i < cutoffBar);
  const after = scanDecideSignals({ candles: corrupt, intervalMs, decide, buildContext, cfg, minCandles, window }).filter((s) => s.i < cutoffBar);
  const identical = before.length === after.length && before.every((s, idx) => JSON.stringify(s.decision) === JSON.stringify(after[idx].decision));
  return { ok: identical, signalsBeforeCutoff: before.length, signalsAfterCorruption: after.length };
}

module.exports = { lookAheadCheck, lookAheadCheckWide, lookAheadCheckDecide, corruptFrom };
