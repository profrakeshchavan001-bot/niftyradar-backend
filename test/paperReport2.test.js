'use strict';
// CC2 round 2 item 5: pure aggregation for /api/paper/report2.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ablation2, shadowSummary, emaCrossWinRate } = require('../src/paper/decision/report2');

test('ablation2: too few trades in a group -> "too few trades, no conclusion"', () => {
  const closed = [
    { status: 'closed', pnl_inr: 100, judge2_contributions: { r_factor: 20, pattern: 20, smc: 10, ema_trend: 8, sector: 8, news: 8, time: 4 } },
    { status: 'closed', pnl_inr: -50, judge2_contributions: { r_factor: 5, pattern: 5, smc: 2, ema_trend: 2, sector: 2, news: 2, time: 1 } },
  ];
  const rows = ablation2(closed, { min_trades_for_conclusion: 20 });
  const r = rows.find((x) => x.helper === 'r_factor');
  assert.equal(r.trades, 2);
  assert.equal(r.enough, false);
  assert.equal(r.verdict, 'too few trades, no conclusion');
});

test('ablation2: with/without split by at least half the helper\'s weight, win rate hand-worked', () => {
  const mk = (pnl, rf) => ({ status: 'closed', pnl_inr: pnl, judge2_contributions: { r_factor: rf, pattern: 0, smc: 0, ema_trend: 0, sector: 0, news: 0, time: 0 } });
  // r_factor weight 25, half = 12.5. 2 trades at rf=20 (>=12.5, "with"), 1 win 1 loss; 2 trades at rf=5 ("without"), both losses.
  const closed = [mk(100, 20), mk(-10, 20), mk(-5, 5), mk(-5, 5)];
  const rows = ablation2(closed, { min_trades_for_conclusion: 2 });
  const r = rows.find((x) => x.helper === 'r_factor');
  assert.deepEqual([r.with.trades, r.with.winRatePct, r.without.trades, r.without.winRatePct], [2, 50, 2, 0]);
  assert.equal(r.enough, true);
});

test('shadowSummary: counts target vs. stop hits and the average result %', () => {
  const shadows = [
    { status: 'closed', outcome: 'target', result_pct: 3.02 },
    { status: 'closed', outcome: 'stop', result_pct: -0.92 },
    { status: 'closed', outcome: 'target', result_pct: 2 },
    { status: 'open' },
  ];
  const s = shadowSummary(shadows);
  // would-have-won = 2 of 3 closed = 66.7%; avg = (3.02 - 0.92 + 2) / 3 = 1.3667 -> 1.37
  assert.deepEqual([s.open, s.closed, s.targetHits, s.stopHits, s.wouldHaveWonPct, s.avgResultPct], [1, 3, 2, 1, 66.7, 1.37]);
});

test('emaCrossWinRate: fresh/confirmed-with vs. everything else, hand-worked', () => {
  const closed = [
    { status: 'closed', pnl_inr: 100, ema_cross: 'fresh_with' },
    { status: 'closed', pnl_inr: -50, ema_cross: 'confirmed_with' },
    { status: 'closed', pnl_inr: -10, ema_cross: 'fresh_against' },
    { status: 'closed', pnl_inr: 20, ema_cross: 'mixed' },
  ];
  const r = emaCrossWinRate(closed);
  // withCross: 2 trades, 1 win (100) of 2 = 50%. other: 2 trades, 1 win (20) of 2 = 50%.
  assert.deepEqual([r.withCross.trades, r.withCross.winRatePct, r.other.trades, r.other.winRatePct], [2, 50, 2, 50]);
});
