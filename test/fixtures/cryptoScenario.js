'use strict';
// Hand-built 5-minute candles for the crypto level tests (not market data).
// Shape, oldest first, starting Fri 13 Nov 2026 01:00 UTC:
//   90 quiet candles at 100 (high 100.2, low 99.8), one of them (number 31) dips to `dip` = the only support level
//   6 green candles of +0.4 each with 0.3 wicks (100 -> 102.4): overlapping, so no gap and no order block
//   small green candle 102.4 -> 102.48 (high 102.52, low 102.36)
//   red trigger candle 102.48 -> 102.18 (high 102.5, low 102.16), volume 300: exhaustion reversal down -> SHORT at 102.18
// Numbers the tests rely on (worked out by hand):
//   15-min ATR14 = (12 quiet candles x 0.4 + 2 rise candles x 1.8) / 14 = 0.6
//   stop   = pattern high 102.52 + 1 x ATR 0.6 = 103.12            (risk 0.94)
//   target = 0.1% before the swing low 99 = 99 x 1.001 = 99.099    (reward 3.081)
//   reward / risk = 3.081 / 0.94 = 3.28
const FIVE = 300000;
const START = Date.UTC(2026, 10, 13, 1, 0);

function build({ dip = 99, after = [] } = {}) {
  const out = [];
  const push = (o, h, l, c, v = 100) => out.push({ t: START + out.length * FIVE, o, h, l, c, v });
  for (let i = 0; i < 90; i++) push(100, 100.2, i === 31 && dip != null ? dip : 99.8, 100);
  let p = 100;
  for (let i = 0; i < 6; i++) { const c = Number((p + 0.4).toFixed(2)); push(p, Number((c + 0.3).toFixed(2)), Number((p - 0.3).toFixed(2)), c); p = c; }
  push(102.4, 102.52, 102.36, 102.48, 90);
  push(102.48, 102.5, 102.16, 102.18, 300);
  for (const [o, h, l, c] of after) push(o, h, l, c);
  return out;
}

const TRIGGER_INDEX = 97;
// the scan that sees the trigger candle just closed (25 s after its end)
const scanTime = (candles) => candles[TRIGGER_INDEX].t + FIVE + 25000;

module.exports = { build, scanTime, FIVE, START, TRIGGER_INDEX };
