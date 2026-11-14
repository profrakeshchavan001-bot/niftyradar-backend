'use strict';
// Builds test/fixtures/paper_replay.json: the candle recording the replay test
// plays back. HAND-BUILT candles (the build machine cannot reach Dhan or
// Binance), shaped like one NSE session and one crypto stretch. Run:
//   node test/fixtures/make-paper-replay.js
const fs = require('fs');
const path = require('path');
const r2 = (x) => Number(x.toFixed(2));
const FIVE = 300000;

function series(startMs, startPrice, steps) {
  const out = [];
  let price = startPrice;
  steps.forEach(([move, wick, v], i) => {
    const o = price;
    const c = r2(o + move);
    out.push({ t: startMs + i * FIVE, o, h: r2(Math.max(o, c) + wick), l: r2(Math.min(o, c) - wick), c, v });
    price = c;
  });
  return out;
}
const rep = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

// NSE: Friday 13 Nov 2026, 09:15 IST = 03:45 UTC. 14 flat candles, a fall
// (5 red, 1 green), a small red candle, then the green trigger candle that
// closes at 11:05 IST, then a slow drift up until 15:30.
const nseStart = Date.UTC(2026, 10, 13, 3, 45);
const nse = series(nseStart, 500, [
  ...rep(14, (i) => [i % 2 ? -0.4 : 0.4, 0.2, 1000]),
  [-2, 0.2, 1500], [-2, 0.2, 1500], [1, 0.2, 1200], [-2, 0.2, 1500], [-2, 0.2, 1500], [-2, 0.2, 1500],
  [-0.4, 0.2, 900],
  [1.4, 0.1, 3000],
  ...rep(53, () => [0.02, 0.01, 800]),
]);
nse[21].h = 492.2; // trigger candle: O 490.6 H 492.2 L 490.5 C 492

// Crypto: same day from 06:00 IST = 00:30 UTC. 32 flat candles, a rise
// (5 green, 1 red), a small green candle, then the red trigger candle.
const cryptoStart = Date.UTC(2026, 10, 13, 0, 30);
const crypto = series(cryptoStart, 100, [
  ...rep(32, (i) => [i % 2 ? -0.1 : 0.1, 0.05, 100]),
  [0.4, 0.05, 150], [0.4, 0.05, 150], [-0.2, 0.05, 120], [0.4, 0.05, 150], [0.4, 0.05, 150], [0.4, 0.05, 150],
  [0.08, 0.04, 90],
  [-0.3, 0.02, 300],
  ...rep(12, () => [0.01, 0.005, 80]),
]);

fs.writeFileSync(path.join(__dirname, 'paper_replay.json'), JSON.stringify({
  note: 'Hand-built candles for the replay test. Not real market data.',
  nse: { symbol: 'TESTSTK', sessionStart: nseStart, candles: nse },
  crypto: { symbol: 'BTCUSDT', start: cryptoStart, candles: crypto },
}, null, 1));
console.log(`nse ${nse.length} candles, crypto ${crypto.length} candles`);
