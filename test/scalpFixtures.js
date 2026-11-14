'use strict';
// Hand-built candles for the scalp tests. Percent maths is done on a price near 100 so every number can be checked on paper.
const MIN = 60000;

// 5-minute candles falling from about 102 to 100.4 (VWAP stays near 101.2, above the price). bump = index whose HIGH is raised to 100.70 (a swing high).
function candles5({ n = 30, endT, bump = null }) {
  return Array.from({ length: n }, (_, i) => {
    let h = 102.1 - 0.06 * i; const l = h - 0.1;
    if (i === bump) h = 100.70;
    return { t: endT - (n - 1 - i) * 5 * MIN, o: h - 0.03, h, l, c: h - 0.06, v: 100 };
  });
}

// 1-minute candles: 32 red candles falling 0.05 each from 102.00 (to 100.40), then a SMALL red candle (body 0.01), then a green candle closing above the small one's high.
//   small: o 100.40 c 100.39 h 100.405 l 100.38 | last: o 100.39 c 100.44 h 100.45 l 100.385  => bullish exhaustion reversal, entry 100.44
function candles1() {
  const out = [];
  let px = 102.0; let t = 0;
  for (let i = 0; i < 32; i++) { out.push({ t, o: px, h: px + 0.025, l: px - 0.05 - 0.025, c: px - 0.05, v: 10 }); px = +(px - 0.05).toFixed(4); t += MIN; }
  out.push({ t, o: 100.40, h: 100.405, l: 100.38, c: 100.39, v: 10 }); t += MIN;
  out.push({ t, o: 100.39, h: 100.45, l: 100.385, c: 100.44, v: 10 });
  return out;
}

// Everything needed to call analyse(): the 1-minute candles end at t0 + 33 minutes, `now` is 5 s after that candle closed.
function scene({ bump = null } = {}) {
  const c1 = candles1();
  const last = c1[c1.length - 1];
  const now = last.t + MIN + 5000;
  const c5 = candles5({ endT: last.t - 4 * MIN, bump }); // last 5-min candle closed at last.t + 1 min
  return { c1raw: c1, c5raw: c5, now, dayStartMs: c5[0].t, last };
}

module.exports = { MIN, candles1, candles5, scene };
