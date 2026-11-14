'use strict';
// Leaderboard stats (docs/BOTS.md): hand-worked numbers, not copied from the function's own output - see the comments next to each case.
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeBotStats, dailyWinners, maxDrawdownInr, NO_CONCLUSION } = require('../src/paper/bots/leaderboard/stats');

const trade = (over) => ({ symbol: 'BTCUSDT', direction: 'LONG', entry_price: 100, exit_price: 101, exit_reason: 'target', basis: 'x', ...over });

// 3 closed trades, closing in this order: t1 (-40), t2 (+100), t3 (+50).
// equity after t1 = -40, peak so far 0, drawdown 0-(-40) = 40
// equity after t2 = 60, peak 60, drawdown max(40, 60-60=0) = 40
// equity after t3 = 110, peak 110, drawdown max(40, 110-110=0) = 40  -> max drawdown 40
// net = -40+100+50 = 110; gross = -30+120+60 = 150; costs = 40; cost% = 40/150 x 100 = 26.7%
// win rate = 2 of 3 = 66.7%; avg win = (100+50)/2 = 75; avg loss = -40; avg minutes = 10 (every trade lasts 10 min here)
test('computeBotStats: 3 trades, hand-worked net/gross/cost%/win-rate/avg-win/avg-loss/drawdown/avg-minutes; under 20 trades is not ranked', () => {
  const closed = [
    trade({ pnl_inr: -40, gross_pnl_inr: -30, entry_time: '2026-11-15T05:00:00Z', exit_time: '2026-11-15T05:10:00Z' }),
    trade({ pnl_inr: 100, gross_pnl_inr: 120, entry_time: '2026-11-15T06:00:00Z', exit_time: '2026-11-15T06:10:00Z' }),
    trade({ pnl_inr: 50, gross_pnl_inr: 60, entry_time: '2026-11-15T07:00:00Z', exit_time: '2026-11-15T07:10:00Z' }),
  ];
  const s = computeBotStats(closed);
  assert.deepEqual([s.trades, s.winRatePct, s.netPnlInr, s.grossPnlInr, s.costsInr], [3, 66.7, 110, 150, 40]);
  assert.equal(s.costPctOfGrossPnl, 26.7); assert.equal(s.avgWinInr, 75); assert.equal(s.avgLossInr, -40);
  assert.equal(s.maxDrawdownInr, 40); assert.equal(maxDrawdownInr(closed), 40); assert.equal(s.avgMinutes, 10);
  assert.equal(s.ranked, false); assert.equal(s.conclusion, NO_CONCLUSION); assert.equal(s.lossAfterCosts, false);
});

test('computeBotStats: 20 trades is ranked; a net loss after costs is flagged plainly', () => {
  const closed = Array.from({ length: 20 }, () => trade({ pnl_inr: -10, gross_pnl_inr: 0 })); // every trade a small net loss after costs
  const s = computeBotStats(closed);
  assert.equal(s.trades, 20); assert.equal(s.ranked, true); assert.equal(s.conclusion, 'enough trades');
  assert.equal(s.netPnlInr, -200); assert.equal(s.lossAfterCosts, true);
});

test('computeBotStats: no closed trades at all -> every rate is "-" (null), never NaN or a crash', () => {
  const s = computeBotStats([]);
  assert.deepEqual([s.trades, s.winRatePct, s.avgWinInr, s.avgLossInr, s.avgMinutes, s.costPctOfGrossPnl], [0, null, null, null, null, null]);
  assert.equal(s.maxDrawdownInr, 0); assert.equal(s.ranked, false); assert.equal(s.lossAfterCosts, false);
});

// Day 1: scalp +100, exhaustion_only +50 -> scalp wins. Day 2: scalp -20, exhaustion_only +30 -> exhaustion_only wins.
test('dailyWinners: the bot with the higher net INR that day wins it, day by day', () => {
  const byBot = {
    scalp: [trade({ pnl_inr: 100, exit_time: '2026-11-15T05:00:00Z' }), trade({ pnl_inr: -20, exit_time: '2026-11-16T05:00:00Z' })],
    exhaustion_only: [trade({ pnl_inr: 50, exit_time: '2026-11-15T06:00:00Z' }), trade({ pnl_inr: 30, exit_time: '2026-11-16T06:00:00Z' })],
  };
  const days = dailyWinners(byBot);
  assert.deepEqual(days.map((d) => [d.date, d.winner, d.netInr]), [['2026-11-15', 'scalp', 100], ['2026-11-16', 'exhaustion_only', 30]]);
});
