'use strict';
// CC2 round 2 item 5: pure aggregation functions for /api/paper/report2 -
// judge v2's ablation table, shadow-tracking results, and win rate with vs.
// without a fresh/confirmed EMA cross. No I/O; the route (paperbot/index.js)
// only reads the store and hands rows to these.
const { HELPERS2, JUDGE2_DEFAULTS } = require('./judge2');
const { merge, r1, isObj } = require('./judge');

const winRatePct = (list) => (list.length ? r1((list.filter((t) => Number(t.pnl_inr) > 0).length / list.length) * 100) : null);
const avgPnl = (list) => (list.length ? Math.round((list.reduce((s, t) => s + Number(t.pnl_inr), 0) / list.length) * 100) / 100 : null);

// Same shape/convention as judge.js's ablation(), for judge2_contributions instead of judge_contributions.
function ablation2(closed, config = {}) {
  const cfg = merge(JUDGE2_DEFAULTS, config);
  const min = cfg.min_trades_for_conclusion || 20;
  const rows = (closed || []).filter((t) => t && t.status !== 'open' && Number.isFinite(Number(t.pnl_inr)) && isObj(t.judge2_contributions));
  return HELPERS2.map((h) => {
    const w = Number(cfg.weights[h]) || 0;
    const have = rows.filter((t) => Number.isFinite(Number(t.judge2_contributions[h])));
    const withH = have.filter((t) => w > 0 && Number(t.judge2_contributions[h]) >= 0.5 * w);
    const without = have.filter((t) => !withH.includes(t));
    const enough = withH.length >= min && without.length >= min;
    return {
      helper: h, weight: w, trades: have.length, enough,
      with: { trades: withH.length, winRatePct: winRatePct(withH), avgPnlInr: avgPnl(withH) },
      without: { trades: without.length, winRatePct: winRatePct(without), avgPnlInr: avgPnl(without) },
      verdict: enough ? 'see with/without above' : 'too few trades, no conclusion',
    };
  });
}

// Closed shadow rows (paper_shadows): how often the rejected setup would have hit its target vs.
// its stop, had it been taken - never a trade, this is only "what would have happened".
function shadowSummary(shadows) {
  const closed = (shadows || []).filter((s) => s.status === 'closed');
  const targets = closed.filter((s) => s.outcome === 'target');
  const stops = closed.filter((s) => s.outcome === 'stop');
  return {
    open: (shadows || []).filter((s) => s.status === 'open').length,
    closed: closed.length,
    targetHits: targets.length,
    stopHits: stops.length,
    wouldHaveWonPct: closed.length ? r1((targets.length / closed.length) * 100) : null,
    avgResultPct: closed.length ? Math.round((closed.reduce((s, x) => s + Number(x.result_pct || 0), 0) / closed.length) * 100) / 100 : null,
  };
}

// Win rate of closed trades WITH a fresh/confirmed EMA cross in the trade's favour vs. every other
// case (against, mixed, unknown) - src/paper/lib/emaCross.js's label, nothing here changes a weight.
function emaCrossWinRate(closed) {
  const rows = (closed || []).filter((t) => t && t.status !== 'open' && Number.isFinite(Number(t.pnl_inr)));
  const withCross = rows.filter((t) => ['fresh_with', 'confirmed_with'].includes(t.ema_cross));
  const other = rows.filter((t) => !['fresh_with', 'confirmed_with'].includes(t.ema_cross));
  return {
    withCross: { trades: withCross.length, winRatePct: winRatePct(withCross), avgPnlInr: avgPnl(withCross) },
    other: { trades: other.length, winRatePct: winRatePct(other), avgPnlInr: avgPnl(other) },
  };
}

module.exports = { ablation2, shadowSummary, emaCrossWinRate };
