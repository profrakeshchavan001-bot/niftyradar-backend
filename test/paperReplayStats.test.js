'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { basicMetrics, buildReport, splitInOutSample } = require('../src/paper/replay/stats');

// 25 hand-picked pnl_inr values (net rupees per trade), worked out on paper (not copied from the function):
//   100,-50,-50,-50,200,-30,-30,-30,-30,-30,150,60,-20,-20,80,-10,-10,-10,-10,-10,-10,300,-40,70,-15
// wins (>0): 100,200,150,60,80,300,70 = 7 of 25 -> win rate 28.00%
// sum(wins) = 960, avg win = 960/7 = 137.142857... -> 137.14
// losses (<=0): -50,-50,-50,-30,-30,-30,-30,-30,-20,-20,-10,-10,-10,-10,-10,-10,-40,-15 = 18 of 25, sum = -455,
//   avg loss = -455/18 = -25.2777... -> -25.28
// net = 100-50-50-50+200-30-30-30-30-30+150+60-20-20+80-10-10-10-10-10-10+300-40+70-15 = 505
// running equity: 100,50,0,-50,150,120,90,60,30,0,150,210,190,170,250,240,230,220,210,200,190,490,450,520,505
// running peak:    100,100,100,100,150,150,150,150,150,150,150,210,210,210,250,250,250,250,250,250,250,490,490,520,520
// drawdown (peak-equity): 0,50,100,150,0,30,60,90,120,150,0,0,20,40,0,10,20,30,40,50,60,0,40,0,15 -> max = 150
// losing streaks (consecutive pnl<=0): 3 (idx2-4), 5 (idx6-10), 2 (idx13-14), 6 (idx16-21), 1, 1 -> longest = 6
const PNL = [100, -50, -50, -50, 200, -30, -30, -30, -30, -30, 150, 60, -20, -20, 80, -10, -10, -10, -10, -10, -10, 300, -40, 70, -15];

function makeTrades(pnls) {
  return pnls.map((pnl_inr, i) => ({ pnl_inr, entry_t: i, symbol: 'BTCUSDT', hour_utc: i % 24 }));
}

test('basicMetrics: hand-verified win rate, net, averages, drawdown and streak', () => {
  const m = basicMetrics(makeTrades(PNL));
  assert.equal(m.trades, 25);
  assert.equal(m.tooFew, false);
  assert.equal(m.winRatePct, 28);
  assert.equal(m.netInr, 505);
  assert.equal(m.avgWinInr, 137.14);
  assert.equal(m.avgLossInr, -25.28);
  assert.equal(m.maxDrawdownInr, 150);
  assert.equal(m.longestLosingStreak, 6);
});

test('basicMetrics: under 20 trades says "too few trades, no conclusion", never a number', () => {
  const m = basicMetrics(makeTrades(PNL.slice(0, 19)));
  assert.equal(m.trades, 19);
  assert.equal(m.tooFew, true);
  assert.equal(m.note, 'too few trades, no conclusion');
  assert.equal('winRatePct' in m, false);
  assert.equal('netInr' in m, false);
});

test('buildReport: overall matches basicMetrics on the same trades, order-independent input', () => {
  const trades = makeTrades(PNL);
  const shuffled = [...trades].reverse(); // buildReport must sort by entry_t itself
  const r = buildReport(shuffled);
  assert.equal(r.overall.netInr, 505);
  assert.equal(r.overall.longestLosingStreak, 6);
});

test('buildReport: byCoin only groups the coins present', () => {
  const trades = [
    { pnl_inr: 10, entry_t: 1, symbol: 'BTCUSDT', hour_utc: 0 },
    { pnl_inr: -5, entry_t: 2, symbol: 'ETHUSDT', hour_utc: 1 },
  ];
  const r = buildReport(trades);
  assert.deepEqual(Object.keys(r.byCoin).sort(), ['BTCUSDT', 'ETHUSDT']);
  assert.equal(r.byCoin.BTCUSDT.tooFew, true); // only 1 trade each
});

test('splitInOutSample: entry_t before the cutoff is in-sample, at or after is out-of-sample', () => {
  const DAY = 86400000;
  const windowStartMs = 0;
  const trades = [
    { entry_t: 0 }, { entry_t: 19 * DAY }, // in-sample (day 0, day 19)
    { entry_t: 20 * DAY }, { entry_t: 29 * DAY }, // out-of-sample (day 20, day 29)
  ];
  const { inSample, outSample } = splitInOutSample(trades, { windowStartMs, inSampleDays: 20 });
  assert.equal(inSample.length, 2);
  assert.equal(outSample.length, 2);
});
