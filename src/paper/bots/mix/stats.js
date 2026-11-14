'use strict';
// Mix: SUGGESTIONS ONLY (docs/BOTS.md). Never trades, never changes anything - a read-only "what would a score-weighted vote of the
// bots have done" view, built purely from trades every bot ALREADY took. Pure functions, no I/O.
const { round } = require('../../lib/indicators');
const { netOf } = require('../leaderboard/stats');

const dirSign = (d) => (d === 'LONG' || d === 'up' ? 1 : d === 'SHORT' || d === 'down' ? -1 : 0);

// weight[bot] = that bot's own win rate (0-1), but ONLY for bots with >= minTrades closed trades; every other bot gets weight 0 -
// "suggested weights only from bots with 20+ trades" (docs/BOTS.md). Not normalized here; normalized per-event in buildSuggestions
// (so a vote only ever reflects the bots that actually had an opinion on that one candle).
function computeWeights(statsByBot, minTrades = 20) {
  const weights = {};
  for (const [bot, s] of Object.entries(statsByBot)) {
    weights[bot] = s.trades >= minTrades ? (s.winRatePct || 0) / 100 : 0;
  }
  return weights;
}

// `tradesByBot`: { bot: [closed trade, ...] }. Groups trades by (symbol, trigger_t) - the same candle, looked at by 2+ bots - and
// for each such group with at least one non-zero weight, works out the score-weighted vote and a weighted-average paper result
// (an APPROXIMATION: each bot's own entry/stop/target differ slightly, so this is the blend of what each bot actually scored on
// that candle, not a fresh backtest of a single combined position - said so again in the report itself, not just here).
function buildSuggestions(tradesByBot, weights) {
  const groups = new Map(); // "symbol|trigger_t" -> [{bot, direction, pnl_inr}]
  for (const [bot, trades] of Object.entries(tradesByBot)) {
    for (const t of trades) {
      const key = `${t.symbol}|${t.trigger_t}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ bot, symbol: t.symbol, trigger_t: t.trigger_t, direction: t.direction, pnl_inr: netOf(t) });
    }
  }
  const out = [];
  for (const [key, entries] of groups) {
    if (entries.length < 2) continue; // only one bot ever looked at this candle - nothing to vote on
    const weighted = entries.filter((e) => (weights[e.bot] || 0) > 0);
    if (!weighted.length) continue; // no participant has 20+ trades yet - no suggested weight to vote with
    const totalW = weighted.reduce((s, e) => s + weights[e.bot], 0);
    const score = weighted.reduce((s, e) => s + weights[e.bot] * dirSign(e.direction), 0) / totalW;
    const suggestedDirection = score > 0.05 ? 'LONG' : score < -0.05 ? 'SHORT' : 'no agreement';
    const weightedPnlInr = round(weighted.reduce((s, e) => s + weights[e.bot] * e.pnl_inr, 0) / totalW, 2);
    out.push({
      symbol: entries[0].symbol, trigger_t: entries[0].trigger_t, score: round(score, 3), suggestedDirection, weightedPnlInr,
      bots: entries.map((e) => ({ bot: e.bot, direction: e.direction, pnl_inr: e.pnl_inr, weight: round(weights[e.bot] || 0, 3) })),
    });
  }
  return out.sort((a, b) => a.trigger_t - b.trigger_t);
}

module.exports = { computeWeights, buildSuggestions };
