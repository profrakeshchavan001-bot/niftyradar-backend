'use strict';
// Look-ahead check (brief item 5): changing future candles must not change past decisions.
// scanSignals() (src/paper/replay/simulator.js) is the only place that decides which candles are "closed
// by now" before handing them to the real, imported analyse(); this proves that windowing never leaks.
const { scanSignals } = require('./simulator');

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

module.exports = { lookAheadCheck, corruptFrom };
